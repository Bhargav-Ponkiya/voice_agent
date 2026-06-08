import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { config } from '../../config';
import { logger } from '../../utils/logger';

export async function createUserToken(roomName: string, participantName: string): Promise<string> {
  const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity: participantName,
    ttl: '4h',
  });

  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  return await token.toJwt();
}

export async function createAgentToken(roomName: string): Promise<string> {
  const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity: 'agent-bot',
    ttl: '4h',
  });

  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
  });

  return await token.toJwt();
}

export async function deleteRoom(roomName: string): Promise<void> {
  if (!config.livekit.url || !config.livekit.apiKey) {
    logger.warn('LiveKit not configured — skipping room deletion');
    return;
  }

  try {
    const svc = new RoomServiceClient(
      config.livekit.url.replace('wss://', 'https://').replace('ws://', 'http://'),
      config.livekit.apiKey,
      config.livekit.apiSecret
    );
    await svc.deleteRoom(roomName);
    logger.info(`LiveKit room deleted: ${roomName}`);
  } catch (err: any) {
    if (err?.message?.includes('Not Found') || err?.message?.includes('does not exist')) {
      logger.info(`LiveKit room ${roomName} already cleaned up automatically`);
    } else {
      logger.warn(`Failed to delete LiveKit room ${roomName}`, err);
    }
  }
}
