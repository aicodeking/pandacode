// Push notification registration with the relay: pure, tested in node. src/ui/push.ts holds the
// native side (permission, device token) and calls these. A relay that predates the endpoint
// answers 404/405; registration then classifies as 'unsupported' and the app stays quiet — no
// error surface, retry on the next launch.

export const REGISTER_PATH = '/v1/push/devices';

export type PushPlatform = 'ios' | 'android';

export interface RegisterBody {
  platform: PushPlatform;
  /** The raw APNs/FCM device token. The relay never learns anything about task content. */
  token: string;
}

export const registerBody = (platform: PushPlatform, rawToken: string): RegisterBody => ({
  platform,
  token: rawToken.slice(0, 512),
});

export const unregisterBody = (platform: PushPlatform, rawToken: string): RegisterBody => registerBody(platform, rawToken);

/** The relay's answer to a registration attempt: enrolled, not implemented yet, or a real failure. */
export type RegisterOutcome = 'enrolled' | 'unsupported' | 'error';

export const classifyRegister = (status: number): RegisterOutcome =>
  status >= 200 && status < 300 ? 'enrolled' : status === 404 || status === 405 || status === 501 ? 'unsupported' : 'error';
