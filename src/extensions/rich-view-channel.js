/* Shared by the isolated host/client and deterministic channel tests. No native bridge. */
function richViewMessage(value, session, kind, sequence) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const text = JSON.stringify(value);
    if (new TextEncoder().encode(text).length > 32768) return false;
    const fields = kind === 'ready' ? 'kind,schemaVersion,sequence,session' : 'dto,kind,schemaVersion,sequence,session,theme';
    if (Object.keys(value).sort().join(',') !== fields || value.schemaVersion !== 1 || value.kind !== kind || value.session !== session || value.sequence !== sequence) return false;
    if (kind === 'ready') return true;
    const dto = value.dto, theme = value.theme;
    return !!dto && Object.keys(dto).sort().join(',') === 'owner,schemaVersion,text,title,version,viewId,windowId'
      && dto.schemaVersion === 1 && ['owner', 'version', 'viewId', 'windowId', 'title', 'text'].every(key => typeof dto[key] === 'string' && dto[key].length <= 4096)
      && !!theme && ['colorScheme,schemaVersion', 'colorScheme,schemaVersion,tokens'].includes(Object.keys(theme).sort().join(','))
      && (theme.tokens === undefined || (theme.tokens && !Array.isArray(theme.tokens) && Object.entries(theme.tokens).length <= 16 && Object.entries(theme.tokens).every(([key, value]) => ['--bg', '--text', '--accent', '--focus', '--muted', '--panel', '--ds-radius-card', '--ds-row-pad-y'].includes(key) && typeof value === 'string' && /^(#[0-9a-fA-F]{6}|[0-9]{1,2}px)$/.test(value))))
      && theme.schemaVersion === 1 && ['dark', 'light'].includes(theme.colorScheme);
  } catch { return false; }
}
/* Liveness between the shell and its frame (R0301): `ping`/`pong` carry the shell's beat number, `fault` is sent once
   by the client when the package's code throws. Same envelope as `ready`; nothing in it reaches the app. */
function richViewSignal(value, session, kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['ping', 'pong', 'fault'].includes(kind)) return false;
  return Object.keys(value).sort().join(',') === 'kind,schemaVersion,sequence,session' && value.schemaVersion === 1 && value.kind === kind && value.session === session
    && Number.isSafeInteger(value.sequence) && value.sequence >= 1;
}
