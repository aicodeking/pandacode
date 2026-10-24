import assert from "node:assert/strict";
import { test } from "node:test";
import { readJsonCapped } from "../src/body.ts";
import { configured } from "../src/config.ts";
import { fullBucket, take } from "../src/bucket.ts";
import { byteLength, parseClientFrame, undeliverableFrame } from "../src/frames.ts";
import { githubUser } from "../src/github.ts";
import { MAX_FRAME_BYTES, STALE_MS, TOKEN_TTL_SECONDS } from "../src/limits.ts";
import { hostChanged, isStale, issuedAfterRegistration, keyChanged, tokenCurrent } from "../src/policy.ts";
import { signToken, verifyToken } from "../src/token.ts";
import { parseDevice } from "../src/validate.ts";

const ID = "3f2b8c1e-9a4d-4e0b-8c55-0a1b2c3d4e5f";
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const device = { id: ID, name: "Mac", platform: "macos", publicKey: KEY };

test("token round trip, expiry, tampering, wrong secret", async () => {
  const t = await signToken("s3cret", "gh:1", ID, 1000);
  assert.deepEqual(await verifyToken("s3cret", t, 1001), { acct: "gh:1", dev: ID, iat: 1000, exp: 1000 + TOKEN_TTL_SECONDS });
  assert.equal(await verifyToken("s3cret", t, 1000 + TOKEN_TTL_SECONDS), null);
  assert.equal(await verifyToken("other", t, 1001), null);
  const [p, s] = t.split(".");
  const forged = btoa(JSON.stringify({ acct: "gh:2", dev: ID, iat: 1, exp: 9e9 })).replace(/=+$/, "");
  assert.equal(await verifyToken("s3cret", `${forged}.${s}`, 1001), null);
  assert.equal(await verifyToken("s3cret", `${p}.`, 1001), null);
  for (const bad of ["", "x", "a.b.c", "!!.!!"]) assert.equal(await verifyToken("s3cret", bad, 1), null);
});

test("refreshed token keeps acct/dev, moves iat and exp forward", async () => {
  const old = await verifyToken("s3cret", await signToken("s3cret", "gh:1", ID, 1000), 1001);
  assert.ok(old);
  const fresh = await verifyToken("s3cret", await signToken("s3cret", old.acct, old.dev, 5000), 5001);
  assert.deepEqual(fresh, { acct: "gh:1", dev: ID, iat: 5000, exp: 5000 + TOKEN_TTL_SECONDS });
  // A device that re-registered after the old token's iat can't use it, but a fresh one passes.
  assert.equal(issuedAfterRegistration(old.iat, 3000), false);
  assert.equal(issuedAfterRegistration(5000, 3000), true);
});

test("bucket allows a burst of 100, refills at 20/s", () => {
  let b = fullBucket(0);
  for (let i = 0; i < 100; i++) {
    const r = take(b, 0);
    assert.ok(r.ok);
    b = r.bucket;
  }
  assert.equal(take(b, 0).ok, false);
  let ok = 0;
  for (let i = 0; i < 30; i++) {
    const r = take(b, 1000);
    if (r.ok) ok++;
    b = r.bucket;
  }
  assert.equal(ok, 20);
});

test("device validation", () => {
  assert.deepEqual(parseDevice(device), device);
  const bad = (over: object) => assert.equal(typeof parseDevice({ ...device, ...over }), "string");
  bad({ id: "nope" });
  bad({ name: "" });
  bad({ name: "x".repeat(65) });
  bad({ publicKey: btoa("short") });
  bad({ publicKey: 5 });
  assert.equal(typeof parseDevice(null), "string");
  assert.equal(typeof parseDevice({ ...device, name: "x".repeat(64) }), "object");
});

test("frame parsing and limits", () => {
  assert.deepEqual(parseClientFrame(JSON.stringify({ to: ID, body: "abc" })), { kind: "send", to: ID, body: "abc" });
  assert.deepEqual(parseClientFrame('{"kind":"host","enabled":true}'), { kind: "host", enabled: true });
  for (const raw of ["x", "[]", '{"kind":"host"}', '{"kind":"zzz"}', `{"to":"x","body":"a"}`, `{"to":"${ID}","body":1}`, new ArrayBuffer(2)]) {
    assert.equal(parseClientFrame(raw).kind, "invalid", String(raw));
  }
  const big = JSON.stringify({ to: ID, body: "é".repeat(MAX_FRAME_BYTES / 2) });
  assert.ok(byteLength(big) > MAX_FRAME_BYTES);
  assert.equal(parseClientFrame(big).kind, "invalid");
});

test("app check request shape and parsing", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const f = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return Response.json({ user: { id: 42, login: "octo", avatar_url: "https://a/b.png" } });
  }) as unknown as typeof fetch;
  assert.deepEqual(await githubUser("tok", "cid", "sec", f), { id: "gh:42", login: "octo", avatarUrl: "https://a/b.png" });
  assert.equal(seen?.url, "https://api.github.com/applications/cid/token");
  assert.equal(seen?.init.method, "POST");
  const h = seen?.init.headers as Record<string, string>;
  assert.equal(h.Authorization, `Basic ${btoa("cid:sec")}`);
  assert.equal(h.Accept, "application/vnd.github+json");
  assert.ok(h["User-Agent"]);
  assert.deepEqual(JSON.parse(String(seen?.init.body)), { access_token: "tok" });
  for (const res of [new Response("", { status: 404 }), new Response("", { status: 422 }), Response.json({ user: null })]) {
    assert.deepEqual(await githubUser("tok", "cid", "sec", (async () => res) as unknown as typeof fetch), { status: 401, error: "GitHub rejected the token" });
  }
});

test("key change decision", () => {
  assert.equal(keyChanged(undefined, KEY), false);
  assert.equal(keyChanged(KEY, KEY), false);
  assert.equal(keyChanged(KEY, btoa(String.fromCharCode(...new Uint8Array(32).fill(8)))), true);
});

test("tokens issued before registration are refused", () => {
  assert.equal(issuedAfterRegistration(100, 100), true);
  assert.equal(issuedAfterRegistration(101, 100), true);
  assert.equal(issuedAfterRegistration(99, 100), false);
  assert.equal(issuedAfterRegistration(Number(null), 100), false);
});

test("frame ref is optional, a string, at most 64 chars", () => {
  assert.deepEqual(parseClientFrame(JSON.stringify({ to: ID, body: "b", ref: "r1" })), { kind: "send", to: ID, body: "b", ref: "r1" });
  assert.deepEqual(parseClientFrame(JSON.stringify({ to: ID.toUpperCase(), body: "b" })), { kind: "send", to: ID, body: "b" });
  assert.equal(parseClientFrame(JSON.stringify({ to: ID, body: "b", ref: "x".repeat(64) })).kind, "send");
  for (const ref of ["x".repeat(65), 5, null]) assert.equal(parseClientFrame(JSON.stringify({ to: ID, body: "b", ref })).kind, "invalid");
  // ASCII just under the limit takes the UTF-8 check and passes.
  const fits = JSON.stringify({ to: ID, body: "a".repeat(MAX_FRAME_BYTES - 100) });
  assert.equal(parseClientFrame(fits).kind, "send");
});

test("undeliverable reply echoes to and ref with a reason", () => {
  assert.deepEqual(JSON.parse(undeliverableFrame(ID, "offline", "r1")), { kind: "undeliverable", to: ID, ref: "r1", reason: "offline" });
  assert.deepEqual(JSON.parse(undeliverableFrame(ID, "rate", "r2")), { kind: "undeliverable", to: ID, ref: "r2", reason: "rate" });
  assert.deepEqual(JSON.parse(undeliverableFrame(ID, "offline")), { kind: "undeliverable", to: ID, reason: "offline" });
});

test("socket staleness at 75 s", () => {
  assert.equal(STALE_MS, 75_000);
  assert.equal(isStale(0, 0), false);
  assert.equal(isStale(1_000, 1_000 + 30_000), false);
  assert.equal(isStale(1_000, 1_000 + STALE_MS - 1), false);
  assert.equal(isStale(1_000, 1_000 + STALE_MS), true);
  assert.equal(isStale(0, 10 * STALE_MS), true);
});

test("host frame that repeats the stored value is a no-op", () => {
  assert.equal(hostChanged(1, true), false);
  assert.equal(hostChanged(0, false), false);
  assert.equal(hostChanged(0, true), true);
  assert.equal(hostChanged(1, false), true);
  assert.equal(hostChanged(undefined, false), true);
});

test("capped body reader stops at the cap, chunked or not", async () => {
  const post = (body: BodyInit) => new Request("https://x/", { method: "POST", body, duplex: "half" } as RequestInit);
  assert.deepEqual(await readJsonCapped(post('{"a":1}'), 100), { value: { a: 1 } });
  assert.equal(await readJsonCapped(post(JSON.stringify({ a: "x".repeat(200) })), 100), "too-large");
  const chunks = new ReadableStream({ start(c) { for (let i = 0; i < 5; i++) c.enqueue(new TextEncoder().encode("x".repeat(30))); c.close(); } });
  assert.equal(await readJsonCapped(post(chunks), 100), "too-large");
  assert.equal(await readJsonCapped(post("{nope"), 100), "invalid");
});

test("secret config check", () => {
  const ok = { SESSION_SECRET: "s".repeat(32), GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "sec" };
  assert.equal(configured(ok, true), true);
  assert.equal(configured({ ...ok, SESSION_SECRET: "s".repeat(31) }, false), false);
  assert.equal(configured({ ...ok, SESSION_SECRET: undefined }, false), false);
  assert.equal(configured({ SESSION_SECRET: ok.SESSION_SECRET }, false), true);
  assert.equal(configured({ SESSION_SECRET: ok.SESSION_SECRET }, true), false);
});

test("gen claim: round trip, mismatch refused, legacy tokens use iat", async () => {
  const c = await verifyToken("s3cret", await signToken("s3cret", "gh:1", ID, 1000, 42), 1001);
  assert.equal(c?.gen, 42);
  assert.equal(tokenCurrent({ gen: 42, iat: 1000 }, { gen: 42, registered_at: 1000 }), true);
  // Same-second revoke + re-register: iat == registered_at would pass, gen does not.
  assert.equal(tokenCurrent({ gen: 42, iat: 1000 }, { gen: 7, registered_at: 1000 }), false);
  assert.equal(tokenCurrent({ iat: 1000 }, { gen: 0, registered_at: 1000 }), true);
  assert.equal(tokenCurrent({ iat: 999 }, { gen: 0, registered_at: 1000 }), false);
  const bad = btoa(JSON.stringify({ acct: "a", dev: ID, iat: 1, exp: 9e9, gen: "x" })).replace(/=+$/, "");
  assert.equal(await verifyToken("s3cret", `${bad}.x`, 2), null);
});
