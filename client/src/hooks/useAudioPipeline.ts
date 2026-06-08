import { useRef, useCallback, useEffect, useState } from 'react';
import { Socket } from 'socket.io-client';

const SAMPLE_RATE = 16000;
const BUFFER_SIZE = 2048;

export function useAudioPipeline(
  socketRef: React.MutableRefObject<Socket | null>,
  isCallActive: boolean,
  isMuted: boolean
) {
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ttsQueueRef = useRef<AudioBuffer[]>([]);
  const ttsPlayingRef = useRef(false);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);

  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const isUserSpeakingRef = useRef(false);

  const isCallActiveRef = useRef(isCallActive);
  const isMutedRef = useRef(isMuted);

  // Keep refs in sync on every render to prevent closure capture
  useEffect(() => {
    isCallActiveRef.current = isCallActive;
  }, [isCallActive]);

  useEffect(() => {
    isMutedRef.current = isMuted;
    if (streamRef.current) {
      streamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = !isMuted;
      });
    }
  }, [isMuted]);

  const initAudioContexts = useCallback(() => {
    // Create contexts synchronously to bypass browser autoplay policies
    if (!audioContextRef.current) {
      // Create at system default sample rate
      audioContextRef.current = new AudioContext();
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume().catch(console.error);
    }
  }, []);

  const startCapture = useCallback(async () => {
    try {
      // Ensure contexts are created
      initAudioContexts();
      const ctx = audioContextRef.current;
      if (!ctx) throw new Error('AudioContext not initialized');

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      streamRef.current = stream;

      // Apply initial mute state
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !isMutedRef.current;
      });

      const source = ctx.createMediaStreamSource(stream);
      sourceNodeRef.current = source;

      const processor = ctx.createScriptProcessor(BUFFER_SIZE, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const socket = socketRef.current;
        const float32 = e.inputBuffer.getChannelData(0);

        // Calculate RMS volume to detect if user is speaking
        let sum = 0;
        for (let i = 0; i < float32.length; i++) {
          sum += float32[i] * float32[i];
        }
        const rms = Math.sqrt(sum / float32.length);

        // Speaking threshold: RMS > 0.015
        const speaking = rms > 0.015 && isCallActiveRef.current && !isMutedRef.current;

        if (speaking !== isUserSpeakingRef.current) {
          isUserSpeakingRef.current = speaking;
          setIsUserSpeaking(speaking);
        }

        if (!socket?.connected || !isCallActiveRef.current || isMutedRef.current) return;
        
        // Resample from ctx.sampleRate to 16000Hz for Deepgram
        const int16 = resampleAndConvertTo16Bit(float32, ctx.sampleRate, 16000);
        socket.emit('audio:chunk', int16.buffer);
      };

      source.connect(processor);
      processor.connect(ctx.destination);

    } catch (err) {
      console.error('Microphone access denied:', err);
      throw new Error('Microphone permission required for voice calls');
    }
  }, [socketRef, initAudioContexts]);

  const stopCapture = useCallback(() => {
    processorRef.current?.disconnect();
    sourceNodeRef.current?.disconnect();
    audioContextRef.current?.close();
    streamRef.current?.getTracks().forEach((t) => t.stop());

    processorRef.current = null;
    sourceNodeRef.current = null;
    audioContextRef.current = null;
    streamRef.current = null;
    ttsQueueRef.current = [];
    ttsPlayingRef.current = false;
    isUserSpeakingRef.current = false;
    setIsUserSpeaking(false);
    activeSourcesRef.current = [];
  }, []);

  const playTTSChunk = useCallback(async (pcmBuffer: ArrayBuffer | ArrayBufferView) => {
    const ctx = audioContextRef.current;
    if (!ctx) {
      console.warn('[AudioPipeline] playTTSChunk called but AudioContext is null!');
      return;
    }

    // Diagnostics
    console.log(`[AudioPipeline] playTTSChunk received chunk of size: ${pcmBuffer.byteLength} bytes. Context state: ${ctx.state}`);

    try {
      // Auto-resume if suspended (browsers automatically suspend idle contexts or when audio endpoints shift)
      if (ctx.state === 'suspended') {
        console.log('[AudioPipeline] Resuming suspended context in playTTSChunk...');
        ctx.resume().catch((e) => console.error('[AudioPipeline] Failed to resume context:', e));
      }

      let int16Array: Int16Array;
      
      if (pcmBuffer instanceof ArrayBuffer) {
        int16Array = new Int16Array(pcmBuffer);
      } else if (ArrayBuffer.isView(pcmBuffer)) {
        // If it's a Uint8Array, Buffer, or other view, use its underlying ArrayBuffer
        int16Array = new Int16Array(
          pcmBuffer.buffer,
          pcmBuffer.byteOffset,
          pcmBuffer.byteLength / 2
        );
      } else {
        throw new Error('Unsupported buffer type');
      }

      const float32Array = new Float32Array(int16Array.length);
      for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 32768.0;
      }

      const audioBuffer = ctx.createBuffer(1, float32Array.length, 24000);
      audioBuffer.copyToChannel(float32Array, 0);

      ttsQueueRef.current.push(audioBuffer);
      if (!ttsPlayingRef.current) {
        playNextInQueue(ctx);
      }
    } catch (err) {
      console.error('[AudioPipeline] TTS playback error:', err);
    }
  }, []);

  const stopTTS = useCallback(() => {
    ttsQueueRef.current = [];
    ttsPlayingRef.current = false;
    
    // Stop all active playing sources without closing context
    activeSourcesRef.current.forEach((src) => {
      try { src.stop(); } catch { /* ignore */ }
    });
    activeSourcesRef.current = [];
  }, []);

  function playNextInQueue(ctx: AudioContext) {
    if (ttsQueueRef.current.length === 0) {
      ttsPlayingRef.current = false;
      return;
    }

    ttsPlayingRef.current = true;
    const buffer = ttsQueueRef.current.shift()!;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    
    activeSourcesRef.current.push(source);
    source.onended = () => {
      activeSourcesRef.current = activeSourcesRef.current.filter((src) => src !== source);
      playNextInQueue(ctx);
    };
    source.start();
  }

  useEffect(() => {
    return () => {
      stopCapture();
    };
  }, [stopCapture]);

  return { initAudioContexts, startCapture, stopCapture, playTTSChunk, stopTTS, isUserSpeaking };
}

function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

function resampleAndConvertTo16Bit(float32: Float32Array, inputSampleRate: number, outputSampleRate: number): Int16Array {
  if (inputSampleRate === outputSampleRate) {
    return float32ToInt16(float32);
  }
  
  const ratio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(float32.length / ratio);
  const result = new Int16Array(newLength);
  
  for (let i = 0; i < newLength; i++) {
    const nextOffset = Math.min(float32.length - 1, Math.floor(i * ratio));
    const s = Math.max(-1, Math.min(1, float32[nextOffset]));
    result[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return result;
}
