// R0306: compares one installed observation record with the expected-observation table. Pure: no I/O, no clock.
// A record is `invalid` (never `passed`) unless it is installed Windows x64 evidence: preview, browser and synthetic
// records never count, and no other target is inferred from this one.

export const OBSERVATION_KIND = 'runtime-windows-panels-observation';
export const RESULT_KIND = 'runtime-windows-panels-result';
export const TARGET = 'windows-x64';

/** The value at a dotted path (`a.b.0.c`), or `undefined`. */
export function at(record, path) {
  let value = record;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

function same(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
}

/** One check of the table against the actual value. */
export function holds(check, actual) {
  switch (check.op) {
    case 'eq': return actual === check.value;
    case 'deepEqual': return same(actual, check.value);
    case 'gte': return typeof actual === 'number' && actual >= check.value;
    case 'lte': return typeof actual === 'number' && actual <= check.value;
    case 'match': return typeof actual === 'string' && new RegExp(check.value).test(actual);
    case 'len': return Array.isArray(actual) && actual.length === check.value;
    case 'includes': return Array.isArray(actual) && actual.includes(check.value);
    case 'project': return Array.isArray(actual) && same(actual.map(entry => Object.fromEntries(check.fields.map(field => [field, entry?.[field]]))), check.value);
    default: throw new Error(`Unknown check operation ${check.op} in ${check.id}.`);
  }
}

/** Why a record cannot stand for installed Windows x64 evidence, or null. */
export function invalidity(record) {
  if (!record || typeof record !== 'object') return 'no record';
  if (record.kind !== OBSERVATION_KIND || record.schemaVersion !== 1) return 'unknown record kind or schema';
  if (record.target !== TARGET) return `the record belongs to ${record.target ?? 'no target'}, not ${TARGET}`;
  if (record.evidence !== 'installed') return `the evidence is ${record.evidence ?? 'unlabelled'}, not installed (preview, browser and synthetic records never count)`;
  if (at(record, 'engines.os.platform') !== 'win32') return 'the host is not Windows';
  if (!at(record, 'identity.candidateCommit') || !at(record, 'identity.sourceFingerprint')) return 'the build identity is missing';
  return null;
}

/** Every check, then the verdict. `failed` names the failing checks; `invalid` names why the record does not count. */
export function evaluate(record, expected) {
  if (expected?.kind !== 'runtime-windows-panels-expected' || expected.target !== TARGET) throw new Error('Not the windows panels expected table.');
  const checks = expected.checks.map(check => {
    const actual = at(record, check.path);
    return { id: check.id, criterion: check.criterion, pass: holds(check, actual), actual: actual === undefined ? null : actual, missing: actual === undefined };
  });
  const invalid = invalidity(record);
  const failing = checks.filter(check => !check.pass).map(check => check.id);
  const verdict = invalid ? 'invalid' : failing.length ? 'failed' : 'passed';
  const criteria = Object.fromEntries(Object.keys(expected.criteria).map(id => {
    const own = checks.filter(check => check.criterion === id);
    // C1 is source reconciliation: no installed observation stands for it.
    return [id, own.length === 0 ? 'not-observed' : invalid ? 'invalid' : own.every(check => check.pass) ? 'passed' : 'failed'];
  }));
  return { schemaVersion: 1, kind: RESULT_KIND, target: TARGET, verdict, reason: invalid ?? (failing.length ? `failing checks: ${failing.join(', ')}` : null), criteria, checks };
}

/** The `rich-panel` scenario entry of a `runtime-platform-qualification-result` for windows-x64 (R1101's record). */
export function platformScenario(result) {
  if (result.verdict === 'passed') return { id: 'rich-panel', outcome: 'passed' };
  return { id: 'rich-panel', outcome: 'failed', reason: `${result.verdict}: ${result.reason}`.slice(0, 500) };
}
