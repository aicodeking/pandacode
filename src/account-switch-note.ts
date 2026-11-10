export const ACCOUNT_SWITCH_PREFIX = 'Account switched\n';

// Only the complete prose emitted by the native pool before it carried a marker.
const nameChar = '[^“”\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]';
const nameEdge = '[^\\s“”\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]';
const quoted = `“${nameEdge}(?:${nameChar}{0,58}${nameEdge})?”`;
const label = `(?:${quoted}|the default (?:Claude|Codex) account)`;
const legacyPrepare = new RegExp(`^Using ${label} because ${label} (?:is out of room or left out of the pool|is near its usage limit|is running more tasks)\\.$`, 'u');
const legacyRotation = new RegExp(`^(?:${quoted}|The default (?:Claude|Codex) account) reached its usage limit, so this task continues on ${label}\\.$`, 'u');

export function accountSwitchDetail(content: string): string | null {
  if (content.startsWith(ACCOUNT_SWITCH_PREFIX)) {
    const detail = content.slice(ACCOUNT_SWITCH_PREFIX.length);
    return detail.trim() ? detail : null;
  }
  // `$` also matches before a final newline; native legacy notes have none.
  if (/[\r\n\u2028\u2029]$/u.test(content)) return null;
  return legacyPrepare.test(content) || legacyRotation.test(content) ? content : null;
}
