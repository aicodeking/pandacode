// A minimal MCP server on stdio (newline-delimited JSON-RPC): answers `initialize` and `tools/list` and ends on EOF.
// Synthetic fixture: it opens no socket and reads no credential. `PROBE_LOG` (optional) gets one line per frame.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const log = process.env.PROBE_LOG;
const tools = [
  { name: 'docs_search', description: 'Search the docs.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'docs_read', description: 'Read one page.', inputSchema: { type: 'object', properties: { page: { type: 'string' } } } },
];
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
createInterface({ input: process.stdin }).on('line', (line) => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (log) appendFileSync(log, `${frame.method ?? 'reply'}\n`);
  if (frame.method === 'initialize') send({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'sample-docs', version: '1.0.0' } } });
  else if (frame.method === 'tools/list') send({ jsonrpc: '2.0', id: frame.id, result: { tools } });
  else if (frame.id !== undefined) send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Method not found' } });
}).on('close', () => process.exit(0));
