// Demo mode's pull request, changed files and diffs (answered by src/demo-host.ts).
import type { Changes, PullDetail } from './connect/types.ts';

const DAY = 86_400_000;
const iso = (ago: number) => new Date(Date.UTC(2026, 9, 20) - ago).toISOString();

const PATCHES: Record<string, string> = {
  'app/account/passkeys.ts': [
    '@@ -0,0 +1,14 @@',
    "+import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';",
    '+',
    '+export async function startRegistration(user: User) {',
    '+  const options = await generateRegistrationOptions({ rpName: RP_NAME, rpID: RP_ID, userName: user.email });',
    '+  await saveChallenge(user.id, options.challenge);',
    '+  return options;',
    '+}',
    '+',
    '+export async function finishRegistration(user: User, response: RegistrationResponseJSON) {',
    '+  const expectedChallenge = await takeChallenge(user.id);',
    '+  const { verified, registrationInfo } = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID });',
    '+  if (verified && registrationInfo) await savePasskey(user.id, registrationInfo.credential);',
    '+  return verified;',
    '+}',
  ].join('\n'),
  'app/account/page.tsx': [
    '@@ -12,9 +12,13 @@ export default function AccountPage() {',
    '   return (',
    '     <Section title="Sign-in">',
    '-      <PasswordForm />',
    '+      <PasskeyButton onRegistered={refresh} />',
    '+      <details>',
    '+        <summary>Use a password instead</summary>',
    '+        <PasswordForm />',
    '+      </details>',
    '     </Section>',
    '   );',
    ' }',
  ].join('\n'),
  'package.json': [
    '@@ -18,6 +18,7 @@',
    '     "next": "16.0.1",',
    '     "react": "19.2.0",',
    '+    "@simplewebauthn/server": "^13.2.0",',
    '     "zod": "^4.1.0"',
    '   }',
  ].join('\n'),
};

export function demoPull(): PullDetail {
  return {
    number: 482, title: 'Add passkey sign-in to the account page', state: 'open', url: 'https://github.com/pandadev/pandacode-web/pull/482',
    author: 'pandadev', base: 'main', head: 'feat/passkeys', additions: 20, deletions: 1, changedFiles: 3,
    createdAt: iso(DAY), updatedAt: iso(0), mergedAt: '', mergeable: 'mergeable', reviewDecision: 'approved',
    body: 'Adds **passkeys** to the account page with `@simplewebauthn/server`.\n\n- Registration and assertion checks on the server\n- Password sign-in stays as a fallback\n\nCloses #471.',
    bodyTruncated: false, labels: ['auth', 'enhancement'],
    checks: [
      { name: 'CI / test', state: 'success', url: '' },
      { name: 'CI / lint', state: 'success', url: '' },
      { name: 'Vercel preview', state: 'pending', url: '' },
    ],
    files: [
      { path: 'app/account/passkeys.ts', additions: 14, deletions: 0 },
      { path: 'app/account/page.tsx', additions: 5, deletions: 1 },
      { path: 'package.json', additions: 1, deletions: 0 },
    ],
    commits: [
      { oid: '9f2c1ab', headline: 'Add passkey registration and assertion', author: 'pandadev', date: iso(DAY) },
      { oid: '41d07e3', headline: 'Keep password sign-in behind a disclosure', author: 'pandadev', date: iso(DAY / 2) },
    ],
    timeline: [
      { kind: 'comment', author: 'mira', body: 'Can we keep the password form one tap away?', state: '', createdAt: iso(DAY / 2) },
      { kind: 'review', author: 'mira', body: 'Looks good, thanks!', state: 'approved', createdAt: iso(DAY / 4) },
    ],
  };
}

export const demoPullPatch = (path: string) => PATCHES[path] ?? '';

type Checkout = Omit<Changes, 'branch'> & { patches: Record<string, string> };

const untracked = (lines: string[]) => [`@@ -0,0 +1,${lines.length} @@`, ...lines.map(line => `+${line}`)].join('\n');

/** Each demo task's uncommitted work, so its Changes read as that task's branch. */
const CHECKOUTS: Record<string, Checkout> = {
  auth: {
    ahead: 2, behind: 0, patches: PATCHES,
    files: [
      { path: 'app/account/passkeys.ts', status: '??', staged: false },
      { path: 'app/account/page.tsx', status: ' M', staged: false },
      { path: 'package.json', status: ' M', staged: false },
    ],
  },
  team: {
    ahead: 4, behind: 1,
    files: [
      { path: 'mobile/src/app/agents.tsx', status: '??', staged: false },
      { path: 'mobile/src/ui/useTeam.ts', status: 'A ', staged: true },
      { path: 'docs/remote-access.md', status: ' M', staged: false },
    ],
    patches: {
      'mobile/src/app/agents.tsx': untracked(["export default function AgentsScreen() {", "  const team = useTeam(device, session);", "  return <WorkerList team={team} />;", '}']),
      'mobile/src/ui/useTeam.ts': untracked(['export const POLL_MS = 5000;']),
      'docs/remote-access.md': ['@@ -40,3 +40,4 @@', ' ## Methods', ' - `task.messages`', '+- `task.team` and `task.workerMessages`', ' - `task.diff`'].join('\n'),
    },
  },
  flaky: {
    ahead: 1, behind: 0,
    files: [
      { path: 'relay/src/upload.ts', status: ' M', staged: false },
      { path: 'relay/tests/upload.test.ts', status: ' M', staged: false },
    ],
    patches: {
      'relay/src/upload.ts': ['@@ -21,4 +21,6 @@ export async function upload(part: Part) {', '-  await put(part);', '+  await retry(() => put(part), { attempts: 3, backoffMs: 200 });', '   return part.etag;', ' }'].join('\n'),
      'relay/tests/upload.test.ts': ['@@ -8,3 +8,3 @@', "-test.skip('retries a dropped part', async () => {", "+test('retries a dropped part', async () => {", '   const server = flakyServer({ failures: 2 });'].join('\n'),
    },
  },
  docs: {
    ahead: 0, behind: 0,
    files: [{ path: 'docs/relay-protocol.md', status: '??', staged: false }, { path: 'README.md', status: ' M', staged: false }],
    patches: {
      'docs/relay-protocol.md': untracked(['# The Connect relay protocol', '', 'Every frame is sealed to one device; the relay only forwards.']),
      'README.md': ['@@ -12,2 +12,3 @@', ' ## Docs', ' - [Getting started](docs/start.md)', '+- [The relay protocol](docs/relay-protocol.md)'].join('\n'),
    },
  },
};

/** Any other task: a small edit on its own branch, so every demo task still shows Changes. */
const OTHER: Checkout = {
  ahead: 1, behind: 0,
  files: [{ path: 'src/index.ts', status: ' M', staged: false }, { path: 'CHANGELOG.md', status: ' M', staged: false }],
  patches: {
    'src/index.ts': ['@@ -3,3 +3,3 @@', ' export function main() {', "-  run('old');", "+  run('new');", ' }'].join('\n'),
    'CHANGELOG.md': ['@@ -1,2 +1,3 @@', ' # Changelog', '+- This task\u2019s change.', ' - Earlier changes.'].join('\n'),
  },
};

const checkout = (sessionId: string) => CHECKOUTS[sessionId] ?? OTHER;

export function demoChanges(sessionId: string, branch: string | undefined): Changes {
  const { ahead, behind, files } = checkout(sessionId);
  return { branch: branch || 'main', ahead, behind, files };
}

/** The checkout's diff (one file with `path`), with Git's file headers like `task.diff`. */
export function demoDiff(sessionId: string, path?: string): string {
  return Object.entries(checkout(sessionId).patches).filter(([file]) => !path || file === path)
    .map(([file, patch]) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${patch}`).join('\n');
}
