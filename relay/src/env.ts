export interface Env {
  ACCOUNT: DurableObjectNamespace;
  AUTH_LIMITER: RateLimit;
  ACCOUNT_LIMITER: RateLimit;
  GLOBAL_AUTH_LIMITER: RateLimit;
  SESSION_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const fail = (status: number, error: string) => json({ error }, status);
