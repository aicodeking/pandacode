// Demo answers for the `rooms` feature group (src/connect/api/rooms.ts): shared bot channels.
// Two rooms are seeded per computer from its bots; posts and replies live in the demo session.
// See ./index.ts.
import type { Room, RoomDetail, RoomMessage } from '../connect/api/rooms.ts';
import type { DemoContext, DemoHandlers } from './index.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Per device, made on first use; posts append to `messages`. */
let rooms: Record<string, RoomDetail[]> = {};

function seedRooms(ctx: DemoContext): RoomDetail[] {
  const bots = ctx.state.bots[ctx.deviceId] ?? [];
  const now = ctx.host.now();
  const ids = bots.map(bot => bot.id);
  if (ids.length < 2) return [];
  const [first, second] = ids;
  const name = (id: string) => bots.find(bot => bot.id === id)?.name ?? 'Bot';
  const message = (id: string, kind: RoomMessage['kind'], authorBotId: string | null, text: string, status: RoomMessage['status'], at: number): RoomMessage => ({ id, kind, authorBotId, text, status, createdAt: at });
  return [
    {
      id: 'room-launch', name: 'launch', memberIds: ids.slice(0, 3), leadBotId: first, archived: false, updatedAt: now - 6 * MIN,
      messages: [
        message('rm-1', 'user', null, 'Where are we on the release? Any blockers left?', 'Completed', now - 42 * MIN),
        message('rm-2', 'assigned', first, `Assigned to ${name(first)}`, 'Completed', now - 42 * MIN),
        message('rm-3', 'reply', first, 'Two blockers: the WebKit test flake and the changelog. I can take the changelog.', 'Completed', now - 38 * MIN),
        message('rm-4', 'assigned', second, `Assigned to ${name(second)}`, 'Completed', now - 38 * MIN),
        message('rm-5', 'reply', second, 'Flake is fixed on a branch, running the suite again now.', 'In progress', now - 6 * MIN),
      ],
      activeBotIds: [second], hasMore: false, truncated: false,
    },
    {
      id: 'room-research', name: 'research', memberIds: ids.slice(1, 4), leadBotId: second, archived: false, updatedAt: now - 3 * HOUR,
      messages: [
        message('rm-6', 'user', null, 'Summarise what changed in the last two releases.', 'Completed', now - 3 * HOUR),
        message('rm-7', 'assigned', second, `Assigned to ${name(second)}`, 'Completed', now - 3 * HOUR),
        message('rm-8', 'reply', second, 'Mostly bot rooms, the inset shell and the reading-width setting.', 'Completed', now - 2 * HOUR - 50 * MIN),
      ],
      activeBotIds: [], hasMore: false, truncated: false,
    },
  ];
}

function roomsOf(ctx: DemoContext): RoomDetail[] {
  const found = rooms[ctx.deviceId] ?? seedRooms(ctx);
  rooms = { ...rooms, [ctx.deviceId]: found };
  return found;
}

function roomIdOf(params: any): string {
  const id = String(params?.channelId ?? '');
  if (!id) throw new Error('Missing channelId.');
  return id;
}

const summary = ({ messages, activeBotIds, hasMore, truncated, ...room }: RoomDetail): Room => room;

export const handlers: DemoHandlers = {
  'rooms.list': ctx => ({ rooms: roomsOf(ctx).map(summary), truncated: false }),
  'rooms.messages': (ctx, params) => {
    const room = roomsOf(ctx).find(item => item.id === roomIdOf(params));
    if (!room) throw new Error('This room no longer exists.');
    const limit = Number(params?.limit ?? room.messages.length);
    const messages = room.messages.slice(-Math.max(1, limit));
    return { ...room, messages, hasMore: room.messages.length > messages.length, truncated: false };
  },
  'rooms.post': (ctx, params) => {
    const id = roomIdOf(params);
    const text = String(params?.text ?? '').trim();
    if (!text) throw new Error('Write a room message.');
    const found = roomsOf(ctx);
    const room = found.find(item => item.id === id);
    if (!room) throw new Error('This room no longer exists.');
    if (room.archived) throw new Error('This room is deleted. Restore it to post.');
    const now = ctx.host.now();
    const post: RoomMessage = { id: `rm-${now.toString(36)}`, kind: 'user', authorBotId: null, text, status: 'In progress', createdAt: now };
    // The named members (or the lead, as the host routes it) pick the post up.
    const named: string[] = Array.isArray(params?.recipients) ? params.recipients.filter((botId: unknown): botId is string => typeof botId === 'string' && room.memberIds.includes(botId)) : [];
    const target = named[0] ?? room.leadBotId;
    const assigned: RoomMessage[] = target && room.memberIds.includes(target)
      ? [{ id: `rm-${now.toString(36)}-a`, kind: 'assigned', authorBotId: target, text: `Assigned to ${ctx.state.bots[ctx.deviceId]?.find(bot => bot.id === target)?.name ?? 'Bot'}`, status: 'Queued', createdAt: now }]
      : [];
    rooms = {
      ...rooms,
      [ctx.deviceId]: found.map(item => item.id === id
        ? { ...item, messages: [...item.messages, post, ...assigned], activeBotIds: target ? [target] : item.activeBotIds, updatedAt: now }
        : item),
    };
    return { posted: true };
  },
};
