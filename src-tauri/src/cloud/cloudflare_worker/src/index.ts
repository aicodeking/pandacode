// PandaCode's sandbox Worker. PandaCode deploys it to your account and calls it with a
// random bearer token kept in your OS keychain. Each name gets its own container that
// stops itself after IDLE_MS without use.
import { DurableObject } from "cloudflare:workers";

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const IDLE_MS = 10 * 60 * 1000;
// Longest a client may ask a container to stay up unattended (24 h).
const MAX_KEEPALIVE_MINUTES = 24 * 60;
const MAX_OUTPUT = 4 * 1024 * 1024;
const WORKSPACE = "/workspace";

interface Env {
  SANDBOX: DurableObjectNamespace<Sandbox>;
  PANDACODE_TOKEN: string;
}

type Result = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean };

function clip(buffer: ArrayBuffer): [string, boolean] {
  const bytes = new Uint8Array(buffer);
  const text = new TextDecoder().decode(bytes.length > MAX_OUTPUT ? bytes.subarray(bytes.length - MAX_OUTPUT) : bytes);
  return [text, bytes.length > MAX_OUTPUT];
}

export class Sandbox extends DurableObject<Env> {
  status(): { running: boolean } {
    return { running: this.container().running };
  }

  async start(): Promise<{ running: boolean }> {
    await this.ensureRunning();
    return { running: true };
  }

  async exec(command: string, timeoutMs: number): Promise<Result> {
    const container = await this.ensureRunning();
    const process = await container.exec(["bash", "-lc", command], { cwd: WORKSPACE });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
    const output = await Promise.race([process.output(), timeout]);
    if (timer !== undefined) clearTimeout(timer);
    if (output === null) return { exitCode: null, stdout: "", stderr: `Timed out after ${Math.round(timeoutMs / 1000)} s.`, timedOut: true, truncated: false };
    const [stdout, cutOut] = clip(output.stdout);
    const [stderr, cutErr] = clip(output.stderr);
    return { exitCode: output.exitCode ?? null, stdout, stderr, timedOut: false, truncated: cutOut || cutErr };
  }

  // Keep the container up for `minutes` with no requests (a detached agent is running).
  // Exec'd processes do not count as activity, so this stretches the inactivity timeout.
  async keepAlive(minutes: number): Promise<{ keepAliveMs: number }> {
    const keepAliveMs = Math.min(Math.max(Math.round(minutes), 1), MAX_KEEPALIVE_MINUTES) * 60_000;
    await this.ctx.storage.put("keepUntil", Date.now() + keepAliveMs);
    await this.ensureRunning();
    return { keepAliveMs };
  }

  async stop(): Promise<void> {
    await this.ctx.storage.delete("keepUntil");
    const container = this.container();
    if (container.running) await container.destroy();
  }

  private container(): Container {
    const container = this.ctx.container;
    if (container === undefined) throw new Error("Container attachment is unavailable");
    return container;
  }

  private async ensureRunning(): Promise<Container> {
    const container = this.container();
    if (!container.running) {
      container.start({ image: container.images.sandbox, instance: "basic", enableInternet: true });
    }
    const keepUntil = (await this.ctx.storage.get<number>("keepUntil")) ?? 0;
    await container.setInactivityTimeout(Math.max(IDLE_MS, keepUntil - Date.now()));
    return container;
  }
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  const expected = new TextEncoder().encode(`Bearer ${env.PANDACODE_TOKEN ?? ""}`);
  const given = new TextEncoder().encode(request.headers.get("authorization") ?? "");
  if (!env.PANDACODE_TOKEN || expected.byteLength !== given.byteLength) return false;
  return crypto.subtle.timingSafeEqual(expected, given);
}

export default {
  async fetch(request, env): Promise<Response> {
    if (!(await authorized(request, env))) return new Response("Unauthorized", { status: 401 });
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, version: 1 });
    const match = /^\/sandboxes\/([^/]+)(\/exec|\/start|\/stop|\/keepalive)?$/.exec(url.pathname);
    if (match === null || !NAME.test(match[1])) return Response.json({ message: "Not found" }, { status: 404 });
    const sandbox = env.SANDBOX.getByName(match[1]);
    try {
      if (match[2] === undefined && request.method === "GET") return Response.json(await sandbox.status());
      if (match[2] === "/start" && request.method === "POST") return Response.json(await sandbox.start());
      if (match[2] === "/stop" && request.method === "POST") { await sandbox.stop(); return Response.json({ running: false }); }
      if (match[2] === undefined && request.method === "DELETE") { await sandbox.stop(); return Response.json({ deleted: true }); }
      if (match[2] === "/keepalive" && request.method === "POST") {
        const body = (await request.json()) as { minutes?: unknown };
        if (typeof body.minutes !== "number" || !Number.isFinite(body.minutes) || body.minutes <= 0) {
          return Response.json({ message: "minutes must be a positive number" }, { status: 400 });
        }
        return Response.json(await sandbox.keepAlive(body.minutes));
      }
      if (match[2] === "/exec" && request.method === "POST") {
        const body = (await request.json()) as { command?: unknown; timeoutMs?: unknown };
        if (typeof body.command !== "string" || body.command.length === 0 || body.command.length > 65536) {
          return Response.json({ message: "command must be a non-empty string" }, { status: 400 });
        }
        const timeoutMs = typeof body.timeoutMs === "number" ? Math.min(Math.max(body.timeoutMs, 1000), 1_800_000) : 120_000;
        return Response.json(await sandbox.exec(body.command, timeoutMs));
      }
      return Response.json({ message: "Method not allowed" }, { status: 405 });
    } catch (cause) {
      console.error({ event: "sandbox.request.failed", path: url.pathname, error: cause instanceof Error ? cause.stack : String(cause) });
      return Response.json({ message: cause instanceof Error ? cause.message : "Sandbox request failed" }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
