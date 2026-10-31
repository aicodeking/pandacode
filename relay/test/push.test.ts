import assert from "node:assert/strict";
import { test } from "node:test";
import { NOTIFY_COALESCE_MS } from "../src/limits.ts";
import { apnsJwt, apnsPayload, notifyTexts, parseNotifyBody, parsePushRegistration, shouldNotify } from "../src/push.ts";
import { parseClientFrame } from "../src/frames.ts";

test("a push registration is a platform and an opaque bounded token", () => {
  assert.deepEqual(parsePushRegistration({ platform: "ios", token: "a".repeat(64) }), { platform: "ios", token: "a".repeat(64) });
  assert.equal(typeof parsePushRegistration({ platform: "windows", token: "x" }), "string");
  assert.equal(typeof parsePushRegistration({ platform: "ios", token: "" }), "string");
  assert.equal(typeof parsePushRegistration({ platform: "ios", token: "x".repeat(513) }), "string");
  assert.equal(typeof parsePushRegistration({ platform: "ios", token: "line\nbreak" }), "string");
  assert.equal(typeof parsePushRegistration(null), "string");
});

test("a notify body is a kind and a count; nothing else rides to the bridge", () => {
  assert.deepEqual(parseNotifyBody({ kind: "waiting", count: 2 }), { kind: "waiting", count: 2 });
  assert.deepEqual(parseNotifyBody({ kind: "finished", count: 0 }), { kind: "finished", count: 0 });
  assert.equal(typeof parseNotifyBody({ kind: "failed", count: 1 }), "string");
  assert.equal(typeof parseNotifyBody({ kind: "waiting", count: 1.5 }), "string");
  assert.equal(typeof parseNotifyBody({ kind: "waiting", count: 100 }), "string");
  assert.equal(typeof parseNotifyBody({ kind: "waiting" }), "string");
  assert.equal(typeof parseNotifyBody("waiting"), "string");
  const frame = parseClientFrame(JSON.stringify({ kind: "notify", body: { kind: "waiting", count: 1 } }));
  assert.deepEqual(frame, { kind: "notify", body: { kind: "waiting", count: 1 } });
  const bad = parseClientFrame(JSON.stringify({ kind: "notify", body: { kind: "nope", count: 1 } }));
  assert.equal(bad.kind, "invalid");
});

test("a burst of events costs one push per window; a kind change or a growing count goes out sooner", () => {
  const t = 1_000_000;
  assert.equal(shouldNotify(t, undefined, { kind: "waiting", count: 1 }), true);
  assert.equal(shouldNotify(t + 1, { kind: "waiting", at: t }, { kind: "waiting", count: 1 }), false);
  assert.equal(shouldNotify(t + NOTIFY_COALESCE_MS, { kind: "waiting", at: t }, { kind: "waiting", count: 1 }), true);
  assert.equal(shouldNotify(t + 1, { kind: "waiting", at: t }, { kind: "finished", count: 0 }), true);
  // Escalation (more tasks waiting) halves the window.
  assert.equal(shouldNotify(t + NOTIFY_COALESCE_MS / 2, { kind: "waiting", at: t }, { kind: "waiting", count: 2 }), true);
  assert.equal(shouldNotify(t + NOTIFY_COALESCE_MS / 4, { kind: "waiting", at: t }, { kind: "waiting", count: 2 }), false);
});

test("alerts say that something needs attention, never which task or what it did", () => {
  assert.deepEqual(notifyTexts({ kind: "waiting", count: 1 }), { title: "PandaCode", body: "A task needs your attention" });
  assert.deepEqual(notifyTexts({ kind: "waiting", count: 3 }), { title: "PandaCode", body: "3 tasks need your attention" });
  assert.deepEqual(notifyTexts({ kind: "finished", count: 1 }).body, "A task finished");
  const payload = apnsPayload({ kind: "waiting", count: 1 }) as { aps: { alert: { body: string } }; url: string };
  assert.match(payload.aps.alert.body, /attention/);
  assert.equal(payload.url, "pandacode://inbox");
  assert.equal(JSON.stringify(payload).includes("sessionId"), false);
});

test("the APNs provider token is a compact ES256 JWT with the key id and team", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  const jwt = await apnsJwt(b64, "KEYID", "TEAMID", 1_700_000_000);
  const [head, claims, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(atob(head.replace(/-/g, "+").replace(/_/g, "/"))), { alg: "ES256", kid: "KEYID" });
  assert.deepEqual(JSON.parse(atob(claims.replace(/-/g, "+").replace(/_/g, "/"))), { iss: "TEAMID", iat: 1_700_000_000 });
  assert.equal(signature.length > 40, true);
});
