// Host calls for the `rooms` feature group (src-tauri/src/remote/methods/rooms.rs): the shared
// bot channels of the desktop's Bots view. Listing and reading are View; posting is Full,
// because a post wakes bots whose turns run on that computer.
import { hostCall } from '../client.ts';
import { registerMethods } from '../rpc.ts';
import { hostCallOnce } from './github.ts';

export const ROOM_METHODS = registerMethods(['rooms.list', 'rooms.messages', 'rooms.post'] as const);

/** A room as `rooms.list` returns it (`bot_shared_channels` plus its ordered members). */
export interface Room {
  id: string;
  name: string;
  memberIds: string[];
  leadBotId: string | null;
  archived: boolean;
  updatedAt: number;
}

/** One timeline row: a post, a bot reply, or the assignment of a post to a member. */
export interface RoomMessage {
  id: string;
  kind: 'user' | 'reply' | 'assigned';
  authorBotId: string | null;
  text: string;
  status: 'Queued' | 'In progress' | 'Completed' | 'Failed' | 'Stopped' | null;
  createdAt: number;
}

export interface RoomDetail extends Room {
  messages: RoomMessage[];
  activeBotIds: string[];
  /** Older history exists beyond this page; ask again with a larger `limit`. */
  hasMore: boolean;
  truncated: boolean;
}

export async function listRooms(deviceId: string): Promise<Room[]> {
  const reply = await hostCall<{ rooms?: Room[] }>(deviceId, 'rooms.list');
  return Array.isArray(reply?.rooms) ? reply.rooms : [];
}

export async function roomMessages(deviceId: string, channelId: string, limit?: number): Promise<RoomDetail | null> {
  const reply = await hostCall<RoomDetail>(deviceId, 'rooms.messages', limit ? { channelId, limit } : { channelId });
  return reply && typeof reply.id === 'string' ? reply : null;
}

/** Posts to a room once per draft: a lost reply is retried under the same `sendId` (github.ts `runOnce`). */
export function postToRoom(deviceId: string, channelId: string, text: string, recipients?: string[]) {
  const params: Record<string, unknown> = { channelId, text };
  if (recipients?.length) params.recipients = recipients;
  return hostCallOnce<{ posted: boolean }>(deviceId, 'rooms.post', params);
}
