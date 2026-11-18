// Demo answers for feature methods (the host's methods/ registry), one file per feature group.
// demoCall in ../demo-host.ts answers the core methods itself and falls through to these; each
// handler gets the demo host and acts on the local demo data, never the network.
//
// A handler may use ../demo-host.ts helpers (sent, replied, withTask...) inside its body only:
// that module imports this one, so they are not ready while these files load.
import type { ConnectState } from '../store/index.ts';
import type { DemoHost } from '../demo-host.ts';
import { handlers as admin } from './admin.ts';
import { handlers as composer } from './composer.ts';
import { handlers as design } from './design.ts';
import { handlers as files } from './files.ts';
import { handlers as git } from './git.ts';
import { handlers as github } from './github.ts';
import { handlers as projects } from './projects.ts';
import { handlers as rewind } from './rewind.ts';
import { handlers as schedules } from './schedules.ts';
import { handlers as search } from './search.ts';
import { handlers as settings } from './settings.ts';
import { handlers as team } from './team-start.ts';
import { handlers as terminal } from './terminal.ts';
import { handlers as threads } from './threads.ts';
import { handlers as tools } from './tools.ts';

export interface DemoContext {
  host: DemoHost;
  deviceId: string;
  /** The demo state when the call arrived; change it with `host.set`. */
  state: ConnectState;
  /** Ends `sessionId`'s run with the canned reply after REPLY_MS, as a send does. */
  reply: (sessionId: string) => void;
}

export type DemoHandler = (ctx: DemoContext, params: any) => unknown;
export type DemoHandlers = Readonly<Record<string, DemoHandler>>;

export const DEMO_GROUPS: Readonly<Record<string, DemoHandlers>> = { threads, composer, git, github, schedules, files, tools, terminal, admin, design, projects, team, settings, rewind, search };

/** Every feature handler by method name; a name in two groups is a bug (tests/demo-host.test.ts). */
export const DEMO_HANDLERS: ReadonlyMap<string, DemoHandler> = new Map(Object.values(DEMO_GROUPS).flatMap(group => Object.entries(group)));
