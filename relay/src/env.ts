export interface Env {
  ACCOUNT: DurableObjectNamespace;
  AUTH_LIMITER: RateLimit;
  ACCOUNT_LIMITER: RateLimit;
  GLOBAL_AUTH_LIMITER: RateLimit;
  SESSION_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  /** Push bridge (relay/src/push.ts): every field optional. A relay without them stores
   * registrations and answers notify frames, but sends nothing. */
  APNS_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_TOPIC?: string;
  FCM_SERVICE_ACCOUNT?: string;
  FCM_PROJECT_ID?: string;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const fail = (status: number, error: string) => json({ error }, status);
