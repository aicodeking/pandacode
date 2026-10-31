import { MAX_FRAME_BYTES, MAX_REF_CHARS } from "./limits.ts";
import { parseNotifyBody, type NotifyBody } from "./push.ts";
import { isUuid } from "./validate.ts";

export type ClientFrame =
  | { kind: "host"; enabled: boolean }
  | { kind: "notify"; body: NotifyBody }
  | { kind: "send"; to: string; body: string; ref?: string }
  | { kind: "invalid"; error: string };

export const byteLength = (s: string) => new TextEncoder().encode(s).byteLength;

export function parseClientFrame(raw: unknown): ClientFrame {
  if (typeof raw !== "string") return { kind: "invalid", error: "frames must be text" };
  // UTF-16 length × 3 bounds the UTF-8 size, so most frames skip the encode copy.
  if (raw.length > MAX_FRAME_BYTES || (raw.length * 3 > MAX_FRAME_BYTES && byteLength(raw) > MAX_FRAME_BYTES)) return { kind: "invalid", error: "frame too large" };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { kind: "invalid", error: "frame is not JSON" };
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { kind: "invalid", error: "frame must be an object" };
  const f = v as Record<string, unknown>;
  if (f.kind === "host") {
    return typeof f.enabled === "boolean" ? { kind: "host", enabled: f.enabled } : { kind: "invalid", error: "host.enabled must be a boolean" };
  }
  if (f.kind === "notify") {
    const body = parseNotifyBody(f.body);
    return typeof body === "string" ? { kind: "invalid", error: body } : { kind: "notify", body };
  }
  if (f.kind !== undefined) return { kind: "invalid", error: "unknown frame kind" };
  if (!isUuid(f.to)) return { kind: "invalid", error: "to must be a device id" };
  if (typeof f.body !== "string") return { kind: "invalid", error: "body must be a string" };
  if (f.ref !== undefined && (typeof f.ref !== "string" || f.ref.length > MAX_REF_CHARS)) {
    return { kind: "invalid", error: `ref must be a string of at most ${MAX_REF_CHARS} characters` };
  }
  const to = f.to.toLowerCase();
  return f.ref === undefined ? { kind: "send", to, body: f.body } : { kind: "send", to, body: f.body, ref: f.ref };
}

/** What the target receives. `from` comes from the socket, never from the sender's frame. */
export const forwardFrame = (from: string, to: string, body: string) => JSON.stringify({ from, to, body });
export const errorFrame = (error: string) => JSON.stringify({ kind: "error", error });
export const undeliverableFrame = (to: string, reason: "offline" | "rate", ref?: string) =>
  JSON.stringify(ref === undefined ? { kind: "undeliverable", to, reason } : { kind: "undeliverable", to, ref, reason });

export interface DeviceView {
  id: string;
  name: string;
  platform: string;
  publicKey: string;
  host: boolean;
  online: boolean;
  lastSeen: number;
}
/** The full registered list, the same shape as `GET /v1/devices`. */
export const presenceFrame = (devices: DeviceView[]) => JSON.stringify({ kind: "presence", devices });
