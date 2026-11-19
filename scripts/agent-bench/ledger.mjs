// Spent cost on disk, written before and after each run, so a restart can't lose or forget it.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';

/** Appends one fsynced line. A crash can cut only the last line, which readLedger skips. */
export function appendLedger(file, entry) {
  const fd = openSync(file, 'a', 0o600);
  try {
    writeSync(fd, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readLedger(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').flatMap(line => { try { return line ? [JSON.parse(line)] : []; } catch { return []; } });
}

/**
 * Every attempt counts once: what it billed, what an interrupted one was charged, or, while it
 * has no ending yet, its whole cap. So a run in flight is already reserved against the budget.
 */
export function ledgerTotals(entries) {
  const attempts = new Map();
  for (const entry of entries) {
    if (entry.type === 'start') attempts.set(entry.attempt, { ...entry, state: 'open', usd: entry.capUsd });
    const known = attempts.get(entry.attempt);
    if (!known) continue;
    if (entry.type === 'end') Object.assign(known, { state: 'ended', usd: entry.billedUsd });
    if (entry.type === 'interrupted') Object.assign(known, { state: 'interrupted', usd: entry.chargedUsd });
  }
  const list = [...attempts.values()];
  const count = state => list.filter(a => a.state === state);
  const sum = items => items.reduce((total, a) => total + a.usd, 0);
  return { totalUsd: sum(list), billedUsd: sum(count('ended')), interruptedUsd: sum(count('interrupted')), reservedUsd: sum(count('open')), open: count('open'), interrupted: count('interrupted').length, ended: count('ended').length };
}

/** The real bill is unknown for a killed run: its last request may still have been charged, so it pays its cap. */
export const interruptedCharge = (capUsd, lastReportedUsd) => Math.max(capUsd, lastReportedUsd ?? 0);

/** run.json and friends are read at startup, so a crash must never leave half a file. */
export function writeAtomic(file, text) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, file);
}

/** The text between `<!-- prereg:X -->` and `<!-- /prereg:X -->` in the doc: what results/preregistrations.jsonl hashes. */
export function preregSection(doc, batch) {
  const open = `<!-- prereg:${batch} -->`;
  const start = doc.indexOf(open);
  const end = doc.indexOf(`<!-- /prereg:${batch} -->`);
  if (start < 0 || end < start) throw new Error(`no pre-registration for batch ${batch}`);
  return doc.slice(start + open.length, end);
}
