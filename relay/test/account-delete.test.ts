import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteAccountState } from "../src/account-delete.ts";

test("account deletion closes every socket before clearing all stored state", async () => {
  const events: string[] = [];
  const stored = new Map<string, unknown>([
    ["devices", [{ id: "device-1" }, { id: "device-2" }]],
    ["other-state", { key: "value" }],
  ]);
  const sockets = [{ id: "socket-1" }, { id: "socket-2" }];

  await deleteAccountState(
    {
      getWebSockets: () => sockets,
      storage: {
        async deleteAll() {
          events.push("delete-all");
          stored.clear();
        },
      },
    },
    (socket, code, reason) => events.push(`close:${socket.id}:${code}:${reason}`),
  );

  assert.deepEqual(events, [
    "close:socket-1:4001:signed out",
    "close:socket-2:4001:signed out",
    "delete-all",
  ]);
  assert.equal(stored.size, 0);
});
