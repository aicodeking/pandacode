// T3 Code's whole app (AppRoot, router, stores, timeline, Markdown) on one thread, mounted like
// src/main.tsx and fed by test/fakeEnvironment.ts, the in-process session its render scenarios use.
// window.__t3bench.update(text) delivers one `turn-item.updated` event, as its server's thread stream does.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryHistory } from "@tanstack/react-router";
import type { ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import "@fontsource-variable/inter";
import "~/index.css";
import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  assistantItem,
  emitThreadEvent,
  installFakeEnvironment,
  isThreadSubscribed,
  runningRun,
  threadWithHistory,
  userItem,
} from "../test/fakeEnvironment";

const HISTORY_TURNS = 20;
const thread = threadWithHistory("bench", HISTORY_TURNS);
const threadId = thread.id as ThreadId;
const live = runningRun(threadId, "live-run", HISTORY_TURNS + 1, "live-user");
installFakeEnvironment([thread]);
__setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, onboardingCompletedAt: "2026-01-01T00:00:00.000Z" });

const router = getRouter(createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${threadId}`] }));
void router.load().then(() => {
  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <AppRoot router={router} />
    </StrictMode>,
  );
});

Object.assign(window, {
  __t3bench: {
    mode: import.meta.env.MODE,
    ready: () =>
      isThreadSubscribed(threadId) &&
      Boolean(document.body.textContent?.includes(`Answer ${HISTORY_TURNS - 1} for ${threadId}.`)),
    /** Starts the live run with its user prompt, as the server does before any reply text. */
    start: async () => {
      await emitThreadEvent(threadId, { type: "run.created", payload: live } as never);
      await emitThreadEvent(threadId, {
        type: "turn-item.updated",
        payload: userItem(threadId, live.id, "live-user", HISTORY_TURNS * 2, "Continue"),
      } as never);
    },
    update: (text: string) =>
      emitThreadEvent(threadId, {
        type: "turn-item.updated",
        payload: assistantItem(threadId, live.id, "live-assistant", HISTORY_TURNS * 2 + 1, text, true),
      } as never),
  },
});
