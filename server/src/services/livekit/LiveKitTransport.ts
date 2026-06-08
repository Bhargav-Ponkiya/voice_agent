import {
  Room,
  RoomEvent,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Track,
  TrackKind,
  RemoteParticipant,
  RemoteTrackPublication,
  RemoteAudioTrack,
  AudioFrame,
} from '@livekit/rtc-node';
import { AgentPipeline } from '../agent/agentPipeline';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { createAgentToken } from './roomService';

export class LiveKitTransport {
  private room: Room;
  private agentPipeline: AgentPipeline;
  private audioSource: AudioSource | null = null;
  private audioStream: AudioStream | null = null;
  private isConnected = false;

  constructor(agentPipeline: AgentPipeline) {
    this.agentPipeline = agentPipeline;
    this.room = new Room();

    this.room.on(RoomEvent.TrackSubscribed, (track: Track, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      logger.info(`[LiveKitTransport] Track subscribed: ${track.sid} from ${participant.identity}`);
      if (track.kind === TrackKind.KIND_AUDIO) {
        this.setupAudioStream(track as RemoteAudioTrack);
      }
    });

    this.room.on(RoomEvent.Disconnected, () => {
      logger.info('[LiveKitTransport] Disconnected from room');
      this.cleanup();
    });
  }

  async connect(roomName: string): Promise<void> {
    try {
      logger.info(`[LiveKitTransport] Connecting to room ${roomName}...`);
      const token = await createAgentToken(roomName);

      // Race the connect against a 45s timeout so a LiveKit Cloud outage doesn't
      // leave call:start hanging forever on the client.
      const CONNECT_TIMEOUT_MS = 45_000;
      let timer: NodeJS.Timeout | null = null;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`LiveKit connect timed out after ${CONNECT_TIMEOUT_MS}ms`)),
          CONNECT_TIMEOUT_MS
        );
      });
      try {
        await Promise.race([this.room.connect(config.livekit.url, token), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }

      // Check if we were cleaned up / disconnected during the connect promise race
      if (!this.room) {
        logger.info('[LiveKitTransport] Connect completed but room was already cleaned up');
        return;
      }

      this.isConnected = true;
      logger.info(`[LiveKitTransport] Connected to room ${roomName}`);

      // 30,000ms (30s) queue to prevent internal Rust buffer overflow which causes "InvalidState" errors and choppy audio
      this.audioSource = new AudioSource(16000, 1, 30000);
      const track = LocalAudioTrack.createAudioTrack('agent-voice', this.audioSource);
      const { TrackPublishOptions, TrackSource } = await import('@livekit/rtc-node');
      const publishOptions = new TrackPublishOptions();
      publishOptions.source = TrackSource.SOURCE_MICROPHONE;
      await this.room.localParticipant?.publishTrack(track, publishOptions);
      logger.info('[LiveKitTransport] Published agent audio track');
      
    } catch (err) {
      logger.error('[LiveKitTransport] Connection failed', err);
      throw err;
    }
  }

  private activeStreamId: number = 0;

  private setupAudioStream(track: RemoteAudioTrack) {
    if (this.audioStream) {
      logger.warn('[LiveKitTransport] AudioStream already exists, replacing...');
      // Bump the id BEFORE assigning so the previous reader loop exits the next time
      // it observes a frame (or never, if the prior stream stalls).
      this.activeStreamId++;
    }

    // Force resampling to 16000Hz mono so it perfectly matches Deepgram STT and CallRecorder expectations
    this.audioStream = new AudioStream(track, 16000, 1);
    const currentStreamId = ++this.activeStreamId;
    const localStream = this.audioStream;

    const readStream = async () => {
      try {
        for await (const frame of localStream as any) {
          if (this.activeStreamId !== currentStreamId || !this.isConnected) break;
          // Deep copy: LiveKit's rtc-node reuses underlying ArrayBuffer slots between
          // frames (the same bug noted in pushAgentAudio). Aliasing the shared buffer
          // into the recorder/STT pipeline would let the next frame corrupt the previous one.
          const src = frame.data;
          const copy = Buffer.allocUnsafe(src.byteLength);
          Buffer.from(src.buffer, src.byteOffset, src.byteLength).copy(copy);
          this.agentPipeline.receiveAudio(copy);
        }
      } catch (err) {
        logger.error('[LiveKitTransport] AudioStream read error', err);
      }
    };

    readStream();
    logger.info('[LiveKitTransport] Setup AudioStream to pipe customer mic to AgentPipeline');
  }

  private capturePromise: Promise<void> = Promise.resolve();
  private audioQueueId: number = 0;

  clearAgentAudioQueue() {
    this.audioQueueId++;
    if (this.audioSource) {
      try {
        this.audioSource.clearQueue();
      } catch (err) {
        logger.warn('[LiveKitTransport] Failed to clear Rust audio queue', err);
      }
    }
  }

  pushAgentAudio(buffer: Buffer) {
    if (!this.isConnected || !this.audioSource) return;
    
    // WebRTC prefers 10ms frames. For 16kHz mono, 10ms is 160 samples (320 bytes).
    const FRAME_SIZE_BYTES = 320;
    const currentQueueId = this.audioQueueId;

    for (let offset = 0; offset < buffer.length; offset += FRAME_SIZE_BYTES) {
      const chunkLen = Math.min(FRAME_SIZE_BYTES, buffer.length - offset);
      const chunk = buffer.subarray(offset, offset + chunkLen);
      
      // CRITICAL FIX: LiveKit's AudioFrame.protoInfo() uses `new Uint8Array(this.data.buffer)`
      // which completely ignores `byteOffset` on TypedArrays and reads from the start of the underlying memory pool!
      // We MUST force a deep copy (.slice()) so the underlying ArrayBuffer is exactly 320 bytes long.
      const chunkCopy = new Uint8Array(chunk).slice();
      const pcm16 = new Int16Array(chunkCopy.buffer);
      const frame = new AudioFrame(pcm16, 16000, 1, pcm16.length);
      
      this.capturePromise = this.capturePromise.then(async () => {
        // If queue was cleared (barge-in) or disconnected, skip sending
        if (this.audioQueueId !== currentQueueId || !this.isConnected || !this.audioSource) {
          return;
        }
        try {
          // Await sequentially to prevent Rust FFI lock collision (InvalidState error)
          await this.audioSource.captureFrame(frame);
        } catch (err: any) {
          logger.error('[LiveKitTransport] Async error in captureFrame:', err?.message || err);
        }
      });
    }
  }

  cleanup() {
    // Idempotent: called from both RoomEvent.Disconnected and AgentPipeline.stop().
    if (!this.isConnected && !this.room && !this.audioSource && !this.audioStream) {
      return;
    }
    this.isConnected = false;
    // Bumping the stream id signals any in-flight readStream() loop to exit.
    this.activeStreamId++;
    this.audioStream = null;
    this.audioSource = null;
    if (this.room) {
      const rm = this.room;
      this.room = null as any; // clear to prevent recursive disconnect loops
      try {
        rm.disconnect();
      } catch (err) {
        logger.warn('[LiveKitTransport] Error disconnecting room on cleanup', err);
      }
    }
    // Note: LiveKit room deletion is handled by index.ts via deleteRoom REST API
  }
}
