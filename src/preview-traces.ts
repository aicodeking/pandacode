import type { Message, ToolActivity } from './types';

/** Browser-preview fixtures for the tool-trace redesign: a replayable "Morning brief" and a "Tool gallery". Opt in with ?trace. */
export const BRIEF_ID = 'session-6';
export const GALLERY_ID = 'session-7';
const json = (value: unknown) => JSON.stringify(value, null, 2);
type Step = Omit<ToolActivity, 'id' | 'status' | 'output'> & { output: string };

const slack = { messages: [
  { user: 'Jane Doe', channel: '#support', ts: '9:41', text: 'Two tickets this morning, both cold sales emails. Closing them.' },
  { user: 'Sam Lee', channel: '#deploys', ts: '11:02', text: 'fix: retry failed uploads is on staging, prod after lunch' },
  { user: 'Alex Kim', channel: '#general', ts: '14:15', text: 'Huddle at 3? My mic is fixed this time, promise.' },
  { user: 'Priya Shah', channel: '#design', ts: '15:30', text: 'Updated onboarding mocks are in Figma.' },
] };
const granola = { meetings: [
  { title: 'Northwind kickoff', author: 'Jane, Sam', time: '10:00', text: 'Scope agreed: three sprints, invoice at month end.' },
  { title: 'Weekly sync', author: 'Team', time: '16:00', text: 'Launch moves to Nov 3, Alex owns the docs.' },
] };
const gmail = { threads: [
  { subject: 'Re: Signed contract', from: 'Jane Doe', time: '8:12', unread: true, snippet: 'Attached the signed copy, two small changes on page 4.' },
  { subject: 'Invoice AC-043', from: 'Northwind Billing', time: 'Yesterday', unread: false, snippet: 'Payment scheduled for Oct 28.' },
  { subject: 'Your October statement', from: 'Acme Bank', time: 'Yesterday', unread: true, snippet: 'Your statement is ready to view.' },
] };
const github = { pull_requests: [
  { title: 'Retry failed uploads', repo: 'acme/app', identifier: 'acme/app#128', number: 128, time: '2h', state: 'merged' },
  { title: 'Add the invoice export', repo: 'acme/app', identifier: 'acme/app#131', number: 131, time: '5h', state: 'open' },
  { title: 'New onboarding', repo: 'acme/web', identifier: 'acme/web#57', number: 57, time: '1d', state: 'draft' },
  { title: 'Bump dependencies', repo: 'acme/web', identifier: 'acme/web#55', number: 55, time: '2d', state: 'open' },
] };
const linear = { issues: [
  { title: 'Export invoices as CSV', identifier: 'ENG-142', state: 'in progress' },
  { title: 'Fix the duplicate invoice number', identifier: 'ENG-139', state: 'todo' },
  { title: 'Ship the new onboarding', identifier: 'ENG-120', state: 'done' },
  { title: 'Retire the old billing page', identifier: 'ENG-117', state: 'todo' },
] };

export const briefTools: Step[] = [
  { name: 'mcp__slack__search_messages', input: json({ query: 'messages since yesterday' }), output: json(slack) },
  { name: 'mcp__granola__get_meetings', input: json({ query: 'notes from today’s calls' }), output: json(granola) },
  { name: 'mcp__gmail__search_threads', input: json({ query: 'unread threads' }), output: json(gmail) },
  { name: 'mcp__github__list_pull_requests', input: json({ owner: 'acme', repo: 'app', query: 'pull requests' }), output: json(github) },
  { name: 'mcp__linear__list_issues', input: json({ query: 'issues' }), output: json(linear) },
];

export const briefAnswer = `### Meetings

- Kickoff with Northwind: scope agreed, invoice at month end [notes](https://granola.ai/notes/northwind-kickoff).

### Slack

- Two support tickets, no reply needed [one](https://slack.com/archives/C024BE91L/p1729843260).
- Shipped \`fix: retry failed uploads\` to staging [commit](https://github.com/acme/app/commit/3f9c2ab).

### Mail

- Jane Doe asked for the signed contract: [jane.doe@example.com](mailto:jane.doe@example.com).
`;

/** Milliseconds after sending, counted frame by frame from the reference video at 30 fps: [start, finish] per tool
 * (each row appears at its start, its card unfolds at its finish), then the answer, which streams from 7.20 s to 9.60 s. */
const TEXT_START = 7200, TEXT_END = 9600, TEXT_CHUNK = 12;
export const briefTimings = {
  tools: [[670, 1170], [2230, 2800], [3700, 4070], [5100, 5430], [6300, 6600]],
  textStart: TEXT_START, textChunk: TEXT_CHUNK,
  textEvery: Math.floor((TEXT_END - TEXT_START) / Math.ceil(briefAnswer.length / TEXT_CHUNK)),
};

export const briefMessages: Message[] = [];

const root = '/Users/you/Projects/orbit';
const galleryTools: Omit<ToolActivity, 'id'>[] = [
  { name: 'Bash', status: 'completed', input: json({ command: 'npm test -- --runInBand', description: 'Run the test suite' }), output: 'PASS src/components/search.test.ts\n  ✓ filters results as the query changes (4 ms)\n\nTests: 12 passed, 12 total\nExit code: 0' },
  { name: 'Read', status: 'completed', input: json({ file_path: `${root}/src/lib/search-index.ts`, limit: 20 }), output: '     1\texport function createSearchIndex(items: Item[]) {\n     2\t  return { search: (query: string) => items.filter(i => i.title.includes(query)) };\n     3\t}\n' },
  { name: 'Edit', status: 'completed', input: json({ file_path: `${root}/src/lib/search-index.ts`, old_string: 'i.title.includes(query)', new_string: 'i.title.toLowerCase().includes(query.toLowerCase())' }), output: `The file ${root}/src/lib/search-index.ts has been updated.` },
  { name: 'MultiEdit', status: 'completed', input: json({ file_path: `${root}/src/components/search.ts`, edits: [{ old_string: 'const index = createSearchIndex(items);', new_string: 'const index = memo(createSearchIndex)(items);' }, { old_string: 'render(results)', new_string: 'render(results.slice(0, 50))' }] }), output: 'Applied 2 edits.' },
  { name: 'Write', status: 'completed', input: json({ file_path: `${root}/src/lib/normalize.ts`, content: 'export const normalize = (text: string) => text.normalize("NFKD").toLowerCase();\n' }), output: `File created successfully at: ${root}/src/lib/normalize.ts` },
  { name: 'Grep', status: 'completed', input: json({ pattern: 'createSearchIndex', path: 'src', output_mode: 'files_with_matches' }), output: 'src/components/search.ts\nsrc/lib/search-index.ts' },
  { name: 'Glob', status: 'completed', input: json({ pattern: 'src/**/*.test.ts' }), output: 'src/components/search.test.ts\nsrc/lib/search-index.test.ts' },
  { name: 'WebSearch', status: 'completed', input: json({ query: 'unicode case folding javascript' }), output: 'Web search results for query: "unicode case folding javascript"\n\nLinks: ' + JSON.stringify([{ title: 'String.prototype.toLowerCase() - MDN', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/toLowerCase' }, { title: 'Unicode Case Folding', url: 'https://www.unicode.org/Public/UCD/latest/ucd/CaseFolding.txt' }]) },
  { name: 'WebFetch', status: 'completed', input: json({ url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/localeCompare', prompt: 'Does localeCompare support case-insensitive comparison?' }), output: 'Yes. Pass `{ sensitivity: "base" }` as the options argument.' },
  { name: 'TodoWrite', status: 'completed', input: json({ todos: [{ content: 'Normalize queries', status: 'completed', activeForm: 'Normalizing queries' }, { content: 'Run the tests', status: 'in_progress', activeForm: 'Running the tests' }, { content: 'Update the docs', status: 'pending', activeForm: 'Updating the docs' }] }), output: 'Todos have been modified successfully.' },
  { name: 'Task', status: 'completed', input: json({ description: 'Audit search callers', subagent_type: 'Explore', prompt: 'List every caller of createSearchIndex and say whether it rebuilds the index per call.' }), output: 'Two callers. src/components/search.ts rebuilds the index on every keystroke; src/lib/palette.ts builds it once.' },
  { name: 'Skill', status: 'completed', input: json({ skill: 'simplify', args: 'src/lib' }), output: 'Launching skill: simplify' },
  { name: 'mcp__pandacode_architect__pandacode_dispatch_workers', status: 'completed', input: json({ workers: [{ name: 'Search fix', prompt: 'Normalize the query and titles.' }, { name: 'Tests', prompt: 'Add accent-insensitive cases.' }] }), output: json({ dispatched: 2, workers: [{ name: 'Search fix', id: 'w-1' }, { name: 'Tests', id: 'w-2' }] }) },
  { name: 'mcp__docs__search_docs', status: 'completed', input: json({ query: 'search index' }), output: json({ results: [{ title: 'Search index', url: 'https://docs.example.com/search-index' }] }) },
  { name: 'Bash', status: 'failed', input: json({ command: 'npm run lint -- src/lib', description: 'Lint the library folder' }), output: 'src/lib/normalize.ts\n  3:10  error  Unicode property escapes need the "u" flag\n\n1 error found\nExit code: 1' },
  { name: 'Bash', status: 'running', input: json({ command: 'npm run build', description: 'Build the app' }), output: '' },
];
export const galleryMessages: Message[] = [
  { id: 701, sessionId: GALLERY_ID, role: 'user', content: 'Show every kind of tool you can run.', createdAt: Date.now() - 120000 },
  ...galleryTools.map((tool, i): Message => ({ id: 710 + i, sessionId: GALLERY_ID, role: 'tool', content: JSON.stringify({ type: 'tool_activity', version: 1, id: `gallery-${i}`, ...tool }), createdAt: Date.now() - 110000 + i * 1000 })),
];
