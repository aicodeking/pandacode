import { DurableObject } from "cloudflare:workers";
import { type Bucket, fullBucket, take } from "./bucket.ts";
import { type Env, fail, json } from "./env.ts";
import { type DeviceView, errorFrame, forwardFrame, parseClientFrame, presenceFrame, undeliverableFrame } from "./frames.ts";
import { MAX_DEVICES, RATE_LIMITED_PARSE_CHARS } from "./limits.ts";
import { hostChanged, isStale, keyChanged, tokenCurrent } from "./policy.ts";
import { isUuid, parseDevice } from "./validate.ts";

interface Attachment extends Bucket {
  device: string;
  /** Join time; counts as the last activity until the first ping is answered. */
  joinedAt: number;
}

const SCHEMA_VERSION = 2;

interface Row {
  id: string;
  name: string;
  platform: string;
  public_key: string;
  host: number;
  last_seen: number;
  registered_at: number;
  gen: number;
  [column: string]: SqlStorageValue;
}

/** One per account (`idFromName("gh:<id>")`). Only the Worker reaches it, after checking the token. */
export class Account extends DurableObject<Env> {
  // Frame buckets per device id, so a reconnect does not refill the burst. After hibernation the socket attachment seeds it.
  private readonly buckets = new Map<string, Bucket>();
  // Sockets this wake already closed or saw leave, so close + error (or revoke + close) broadcast once.
  private readonly departed = new WeakSet<WebSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.migrate();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private migrate(): void {
    const sql = this.ctx.storage.sql;
    let version: number;
    try {
      version = Number(sql.exec<{ user_version: number }>("PRAGMA user_version").one().user_version);
    } catch {
      version = -1; // PRAGMA refused: fall back to the idempotent path below.
    }
    if (version >= SCHEMA_VERSION) return;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS devices (
         id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, public_key TEXT NOT NULL,
         host INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL DEFAULT 0)`,
    );
    // Accounts created before registered_at existed get the column once.
    if (!sql.exec<{ name: string }>("PRAGMA table_info(devices)").toArray().some((c) => c.name === "registered_at")) {
      sql.exec("ALTER TABLE devices ADD COLUMN registered_at INTEGER NOT NULL DEFAULT 0");
    }
    // gen (schema 2): existing rows get 0; tokens without a gen claim still use the iat check.
    if (!sql.exec<{ name: string }>("PRAGMA table_info(devices)").toArray().some((c) => c.name === "gen")) {
      sql.exec("ALTER TABLE devices ADD COLUMN gen INTEGER NOT NULL DEFAULT 0");
    }
    if (version >= 0) sql.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/internal/register") return this.register(await request.json());
    // Every request is checked against the registered devices, so a revoked token stops working at once.
    const device = request.headers.get("x-device-id") ?? "";
    const row = this.row(device);
    if (!row) return fail(401, "device is not registered");
    const gen = request.headers.get("x-token-gen");
    if (!tokenCurrent({ iat: Number(request.headers.get("x-token-iat")), gen: gen === null ? undefined : Number(gen) }, row)) {
      return fail(401, "token was issued before the device registered");
    }

    if (pathname === "/v1/connect") return this.join(request, device);
    // The Worker signs the fresh token after this 200; reaching here means the device is still registered.
    if (pathname === "/v1/token") return request.method === "POST" ? json({ ok: true, gen: row.gen }) : fail(405, "method not allowed");
    if (pathname === "/v1/devices" && request.method === "GET") {
      if (this.reap()) this.broadcastPresence();
      return json({ devices: this.devices() });
    }
    const id = /^\/v1\/devices\/([^/]+)$/.exec(pathname)?.[1];
    if (id && request.method === "DELETE") return this.revoke(id);
    return fail(id || pathname === "/v1/devices" ? 405 : 404, id || pathname === "/v1/devices" ? "method not allowed" : "not found");
  }

  private register(input: unknown): Response {
    const d = parseDevice(input);
    if (typeof d === "string") return fail(400, d);
    const existing = this.row(d.id);
    if (keyChanged(existing?.public_key, d.publicKey)) return fail(409, "device key changed");
    if (!existing && this.rows().length >= MAX_DEVICES) return fail(403, `device limit reached (${MAX_DEVICES})`);
    // gen is set only on a fresh insert (the row is gone after a revoke). A plain re-sign-in of a registered device keeps it,
    // so that device's other valid tokens keep working; they carry the same key and are the same device.
    const gen = crypto.getRandomValues(new Uint32Array(1))[0];
    this.ctx.storage.sql.exec(
      `INSERT INTO devices (id, name, platform, public_key, last_seen, registered_at, gen) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, platform = excluded.platform`,
      d.id, d.name, d.platform, d.publicKey, Date.now(), Math.floor(Date.now() / 1000), gen,
    );
    return json({ ok: true, gen: this.row(d.id)?.gen ?? gen });
  }

  private revoke(raw: string): Response {
    const id = raw.toLowerCase();
    if (!isUuid(id)) return fail(400, "device id must be a UUID");
    if (!this.row(id)) return fail(404, "device not found");
    this.ctx.storage.sql.exec("DELETE FROM devices WHERE id = ?", id);
    this.buckets.delete(id);
    for (const ws of this.ctx.getWebSockets(id)) this.close(ws, 4001, "revoked");
    this.broadcastPresence();
    return json({ ok: true });
  }

  private join(request: Request, device: string): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return fail(426, "WebSocket upgrade required");
    const hostParam = new URL(request.url).searchParams.get("host");
    const host = hostParam === "1" ? 1 : hostParam === "0" ? 0 : null;
    const now = Date.now();
    // Seed from the old socket before closing it, so a reconnect after hibernation does not refill the burst.
    const old = this.ctx.getWebSockets(device);
    const prior = old.map((ws) => ws.deserializeAttachment() as Attachment | null).find((a) => a !== null);
    const bucket = this.buckets.get(device) ?? (prior ? { tokens: prior.tokens, at: prior.at } : fullBucket(now));
    for (const ws of old) this.close(ws, 4000, "replaced by a newer connection");
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [device]);
    pair[1].serializeAttachment({ device, ...bucket, joinedAt: now } satisfies Attachment);
    this.ctx.storage.sql.exec("UPDATE devices SET last_seen = ?, host = COALESCE(?, host) WHERE id = ?", now, host, device);
    this.broadcastPresence();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return ws.close(1011, "missing attachment");
    const now = Date.now();
    const spent = take(this.buckets.get(att.device) ?? att, now);
    this.buckets.set(att.device, spent.bucket);
    ws.serializeAttachment({ device: att.device, joinedAt: att.joinedAt, ...spent.bucket } satisfies Attachment);

    // Parsed before the bucket check so a small rate-limited send can still name its `to` and `ref`; a large one is not parsed at all.
    if (!spent.ok && (typeof message !== "string" || message.length > RATE_LIMITED_PARSE_CHARS)) return this.send(ws, errorFrame("rate limit exceeded"));
    const frame = parseClientFrame(message);
    if (!spent.ok) {
      return this.send(ws, frame.kind === "send" ? undeliverableFrame(frame.to, "rate", frame.ref) : errorFrame("rate limit exceeded"));
    }
    if (frame.kind === "invalid") return this.send(ws, errorFrame(frame.error));
    if (frame.kind === "host") {
      if (!hostChanged(this.row(att.device)?.host, frame.enabled)) return;
      this.ctx.storage.sql.exec("UPDATE devices SET host = ? WHERE id = ?", frame.enabled ? 1 : 0, att.device);
      return this.broadcastPresence();
    }
    if (this.reap(frame.to)) this.broadcastPresence();
    const targets = this.ctx.getWebSockets(frame.to).filter((s) => this.live(s, now));
    if (targets.length === 0) return this.send(ws, undeliverableFrame(frame.to, "offline", frame.ref));
    const out = forwardFrame(att.device, frame.to, frame.body);
    for (const t of targets) this.send(t, out);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    if (this.departed.has(ws)) return; // we closed it (revoke, replace, stale): already handled
    this.departed.add(ws);
    // Reciprocate the peer's close (a no-op when the runtime already auto-replied).
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "closed"); } catch { /* already closed */ }
    this.left(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    if (this.departed.has(ws)) return;
    this.departed.add(ws);
    this.left(ws);
  }

  private left(ws: WebSocket): void {
    const device = (ws.deserializeAttachment() as Attachment | null)?.device;
    if (!device) return;
    this.markGone(device);
    this.broadcastPresence();
  }

  /** Close once; later close/error events for this socket are ignored. */
  private close(ws: WebSocket, code: number, reason: string): void {
    this.departed.add(ws);
    if (ws.readyState !== WebSocket.READY_STATE_OPEN) return;
    try { ws.close(code, reason); } catch { /* already closed */ }
  }

  private markGone(device: string): void {
    if (!this.online(device)) this.ctx.storage.sql.exec("UPDATE devices SET host = 0, last_seen = ? WHERE id = ?", Date.now(), device);
  }

  private live(ws: WebSocket, now: number): boolean {
    if (ws.readyState !== WebSocket.READY_STATE_OPEN || this.departed.has(ws)) return false;
    const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime();
    return !isStale(pinged ?? (ws.deserializeAttachment() as Attachment | null)?.joinedAt ?? 0, now);
  }

  /** Close sockets that stopped answering pings. Returns true when presence changed, so the caller broadcasts. */
  private reap(tag?: string): boolean {
    const now = Date.now();
    const gone = new Set<string>();
    for (const ws of this.ctx.getWebSockets(tag)) {
      if (ws.readyState !== WebSocket.READY_STATE_OPEN || this.departed.has(ws) || this.live(ws, now)) continue;
      this.close(ws, 4002, "no ping");
      const device = (ws.deserializeAttachment() as Attachment | null)?.device;
      if (device) gone.add(device);
    }
    for (const device of gone) this.markGone(device);
    return gone.size > 0;
  }

  private online(id: string): boolean {
    const now = Date.now();
    return this.ctx.getWebSockets(id).some((s) => this.live(s, now));
  }

  private devices(): DeviceView[] {
    return this.rows().map((r) => {
      const online = this.online(r.id);
      return { id: r.id, name: r.name, platform: r.platform, publicKey: r.public_key, host: online && r.host === 1, online, lastSeen: r.last_seen };
    });
  }

  private broadcastPresence(): void {
    this.reap();
    const frame = presenceFrame(this.devices());
    const now = Date.now();
    for (const s of this.ctx.getWebSockets()) if (this.live(s, now)) this.send(s, frame);
  }

  private send(ws: WebSocket, data: string): void {
    try { ws.send(data); } catch { /* peer is gone; its close handler runs separately */ }
  }

  private rows(): Row[] {
    return this.ctx.storage.sql.exec<Row>("SELECT * FROM devices ORDER BY name").toArray();
  }

  private row(id: string): Row | undefined {
    return this.ctx.storage.sql.exec<Row>("SELECT * FROM devices WHERE id = ?", id).toArray()[0];
  }
}

