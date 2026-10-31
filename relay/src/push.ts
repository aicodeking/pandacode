import { MAX_NOTIFY_CHARS, MAX_PUSH_TOKENS_PER_DEVICE, MAX_PUSH_TOKEN_CHARS, NOTIFY_COALESCE_MS } from "./limits.ts";

/**
 * Push notifications: registration, the notify frame hosts send, the coalescing policy and the
 * APNs/FCM bridge. Everything here is content-blind by design — payloads carry counts and kinds,
 * never task text, so the relay still has nothing to decrypt. Tested pure logic in test/push.test.ts;
 * `deliverPush` is the only networked piece and runs best-effort from the Account object.
 */

export type PushPlatform = "ios" | "android";

export interface PushRegistration {
  platform: PushPlatform;
  token: string;
}

export interface NotifyBody {
  kind: "waiting" | "finished";
  count: number;
}

const PLATFORMS: readonly string[] = ["ios", "android"];
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A registration body: `{ platform, token }`. The token is opaque to the relay; it is bounded
 * and stored as-is, and one device keeps at most `MAX_PUSH_TOKENS_PER_DEVICE` of them. */
export function parsePushRegistration(v: unknown): PushRegistration | string {
  if (typeof v !== "object" || v === null) return "body is required";
  const d = v as Record<string, unknown>;
  if (!PLATFORMS.includes(String(d.platform))) return "platform must be ios or android";
  if (typeof d.token !== "string" || !d.token || d.token.length > MAX_PUSH_TOKEN_CHARS || CONTROL.test(d.token)) {
    return `token must be 1-${MAX_PUSH_TOKEN_CHARS} characters`;
  }
  return { platform: d.platform as PushPlatform, token: d.token };
}

/** The body of a host's notify frame: `{ kind: "waiting" | "finished", count }`. `count` says how
 * many tasks the notice is about; no session ids, no text. */
export function parseNotifyBody(v: unknown): NotifyBody | string {
  if (typeof v !== "object" || v === null) return "notify.body is required";
  const b = v as Record<string, unknown>;
  if (b.kind !== "waiting" && b.kind !== "finished") return "notify.body.kind must be waiting or finished";
  if (typeof b.count !== "number" || !Number.isInteger(b.count) || b.count < 0 || b.count > 99) {
    return "notify.body.count must be an integer from 0 to 99";
  }
  return { kind: b.kind, count: b.count };
}

/** True when this notice deserves a push: the first one, a kind change, a growing waiting count
 * (escalation halves the window), or the coalesce window having passed. Everything else folds
 * into what was already sent, so a burst of events costs at most one push per window. */
export function shouldNotify(now: number, previous: { kind: NotifyBody["kind"] | ""; at: number } | undefined, next: NotifyBody): boolean {
  if (!previous) return true;
  if (next.kind !== previous.kind) return true;
  if (next.kind === "waiting" && next.count > 0) return now - previous.at >= NOTIFY_COALESCE_MS / 2;
  return now - previous.at >= NOTIFY_COALESCE_MS;
}

/** The alert text, per kind. Generic on purpose: the same words for every task. */
export function notifyTexts(body: NotifyBody): { title: string; body: string } {
  if (body.kind === "waiting") {
    return { title: "PandaCode", body: body.count > 1 ? `${body.count} tasks need your attention` : "A task needs your attention" };
  }
  return { title: "PandaCode", body: body.count > 1 ? `${body.count} tasks finished` : "A task finished" };
}

/** The APNs alert payload: generic text plus the deep link. `url` is the only custom key. */
export const apnsPayload = (body: NotifyBody): object => ({
  aps: { alert: notifyTexts(body), sound: "default" },
  url: "pandacode://inbox",
});

const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** Signs the APNs provider token (ES256, `kid` in the header, team id as `iss`). Returns the
 * compact JWT; the key arrives as base64 PKCS#8 (the .p8 file's body). */
export async function apnsJwt(keyP8Base64: string, keyId: string, teamId: string, now: number): Promise<string> {
  const der = Uint8Array.from(atob(keyP8Base64.replace(/\s/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64url(new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid: keyId })));
  const claims = b64url(new TextEncoder().encode(JSON.stringify({ iss: teamId, iat: now })));
  const signed = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${head}.${claims}`));
  return `${head}.${claims}.${b64url(signed)}`;
}

/** Exchanges a Firebase service-account JSON for a v1 API access token (RS256 JWT → OAuth). */
export async function fcmAccessToken(serviceAccountJson: string, now: number): Promise<string> {
  const account = JSON.parse(serviceAccountJson) as { client_email?: string; private_key?: string };
  if (!account.client_email || !account.private_key) throw new Error("service account is missing fields");
  const head = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = b64url(new TextEncoder().encode(JSON.stringify({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemBody(account.private_key),
    { name: "RSASSA-PKCS1-v1_5" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${claims}`));
  const jwt = `${head}.${claims}.${b64url(signed)}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("token exchange returned no access_token");
  return body.access_token;
}

const pemBody = (pem: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));

/** Sends one notice to one device token. Env-gated: a relay without the platform's secrets
 * skips it silently, so registering before configuring push costs nothing. */
export async function deliverPush(env: {
  APNS_KEY?: string; APNS_KEY_ID?: string; APNS_TEAM_ID?: string; APNS_TOPIC?: string;
  FCM_SERVICE_ACCOUNT?: string; FCM_PROJECT_ID?: string;
}, registration: PushRegistration, body: NotifyBody): Promise<boolean> {
  if (registration.platform === "ios") {
    if (!env.APNS_KEY || !env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_TOPIC) return false;
    const jwt = await apnsJwt(env.APNS_KEY, env.APNS_KEY_ID, env.APNS_TEAM_ID, Math.floor(Date.now() / 1000));
    const res = await fetch(`https://api.push.apple.com/3/device/${encodeURIComponent(registration.token)}`, {
      method: "POST",
      headers: { authorization: `bearer ${jwt}`, "apns-topic": env.APNS_TOPIC, "apns-push-type": "alert", "apns-priority": "10", "content-type": "application/json" },
      body: JSON.stringify(apnsPayload(body)),
    });
    if (!res.ok) throw new Error(`apns refused: ${res.status}`);
    return true;
  }
  if (!env.FCM_SERVICE_ACCOUNT || !env.FCM_PROJECT_ID) return false;
  const accessToken = await fcmAccessToken(env.FCM_SERVICE_ACCOUNT, Math.floor(Date.now() / 1000));
  const { title, body: text } = notifyTexts(body);
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(env.FCM_PROJECT_ID)}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ message: { token: registration.token, notification: { title, body: text }, data: { url: "pandacode://inbox" } } }),
  });
  if (!res.ok) throw new Error(`fcm refused: ${res.status}`);
  return true;
}

export const PUSH_LIMITS = { perDevice: MAX_PUSH_TOKENS_PER_DEVICE, tokenChars: MAX_PUSH_TOKEN_CHARS, notifyChars: MAX_NOTIFY_CHARS, coalesceMs: NOTIFY_COALESCE_MS };
