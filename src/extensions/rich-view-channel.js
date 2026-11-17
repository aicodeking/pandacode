/* Shared by the isolated host/client and deterministic channel tests. No native bridge. */
/* The finite theme: a color scheme and at most 16 known tokens (R0303 shares it with the channel's theme push). */
function richViewTheme(theme) {
  return !!theme && typeof theme === 'object' && !Array.isArray(theme) && ['colorScheme,schemaVersion', 'colorScheme,schemaVersion,tokens'].includes(Object.keys(theme).sort().join(','))
    && (theme.tokens === undefined || (theme.tokens && typeof theme.tokens === 'object' && !Array.isArray(theme.tokens) && Object.entries(theme.tokens).length <= 16 && Object.entries(theme.tokens).every(([key, value]) => ['--bg', '--text', '--accent', '--focus', '--muted', '--panel', '--ds-radius-card', '--ds-row-pad-y'].includes(key) && typeof value === 'string' && /^(#[0-9a-fA-F]{6}|[0-9]{1,2}px)$/.test(value))))
    && theme.schemaVersion === 1 && ['dark', 'light'].includes(theme.colorScheme);
}
/* R0303: the instance an init carries beside the presentation DTO (only for a served panel with a channel). */
function richViewInstance(instance) {
  if (!instance || typeof instance !== 'object' || Array.isArray(instance)) return false;
  const keys = Object.keys(instance).sort().join(',');
  return ['instanceId,placement,restored,viewId', 'instanceId,placement,restored,state,viewId'].includes(keys)
    && typeof instance.instanceId === 'string' && instance.instanceId.length <= 64 && typeof instance.viewId === 'string' && instance.viewId.length <= 160
    && ['inspector', 'window', 'floating', 'band', 'editor'].includes(instance.placement) && typeof instance.restored === 'boolean'
    && (instance.state === undefined || richViewBytes(instance.state) <= RICH_VIEW_LIMIT);
}
function richViewMessage(value, session, kind, sequence) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const text = JSON.stringify(value);
    // The handshake and the presentation DTO stay within 32 KB; an init that carries an instance and its state (R0303)
    // may hold the 256 KiB state plus its envelope.
    const extended = kind === 'init' && Object.prototype.hasOwnProperty.call(value, 'instance');
    if (new TextEncoder().encode(text).length > (extended ? 278528 : 32768)) return false;
    const fields = kind === 'ready' ? 'kind,schemaVersion,sequence,session' : extended ? 'dto,instance,kind,schemaVersion,sequence,session,theme' : 'dto,kind,schemaVersion,sequence,session,theme';
    if (Object.keys(value).sort().join(',') !== fields || value.schemaVersion !== 1 || value.kind !== kind || value.session !== session || value.sequence !== sequence) return false;
    if (kind === 'ready') return true;
    if (extended && !richViewInstance(value.instance)) return false;
    const dto = value.dto, theme = value.theme;
    return !!dto && Object.keys(dto).sort().join(',') === 'owner,schemaVersion,text,title,version,viewId,windowId'
      && dto.schemaVersion === 1 && ['owner', 'version', 'viewId', 'windowId', 'title', 'text'].every(key => typeof dto[key] === 'string' && dto[key].length <= 4096)
      && richViewTheme(theme);
  } catch { return false; }
}
/* Liveness between the shell and its frame (R0301): `ping`/`pong` carry the shell's beat number, `fault` is sent once
   by the client when the package's code throws. Same envelope as `ready`; nothing in it reaches the app. */
function richViewSignal(value, session, kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['ping', 'pong', 'fault'].includes(kind)) return false;
  return Object.keys(value).sort().join(',') === 'kind,schemaVersion,sequence,session' && value.schemaVersion === 1 && value.kind === kind && value.session === session
    && Number.isSafeInteger(value.sequence) && value.sequence >= 1;
}
/* R0303: the channel after the handshake, between the frame, its shell and the host. Closed shapes per kind: a kind
   outside this table (`invoke`) or an extra field (`command`) is never one. Panel to host: `post`, `state`, `call`,
   `focus`; host to panel: `message`, `reply`, `visibility`, `theme`. Messages and state hold at most 256 KiB of JSON
   (the callers say so with an actionable error); the envelope adds at most 16 KiB. */
const RICH_VIEW_LIMIT = 262144;
const RICH_VIEW_SHAPES = {
  post: ['id,kind,message,schemaVersion,session'], state: ['kind,schemaVersion,session,value'], call: ['args,id,kind,path,schemaVersion,session'],
  focus: ['focused,kind,schemaVersion,session'], message: ['kind,message,schemaVersion,session'],
  reply: ['error,id,kind,ok,schemaVersion,session', 'id,kind,ok,schemaVersion,session,value'],
  visibility: ['kind,schemaVersion,session,visible', 'focused,kind,schemaVersion,session,visible'], theme: ['kind,schemaVersion,session,theme'],
};
function richViewBytes(value) {
  try { const text = JSON.stringify(value); return text === undefined ? Infinity : new TextEncoder().encode(text).length; } catch { return Infinity; }
}
function richViewServiceOnly(path) {
  const namespace = String(path).split('.')[0];
  return ['secrets', 'auth', 'internal', 'events', 'hooks', 'modelTools', 'commands', 'views', 'providers'].includes(namespace) || path === 'storage.directory';
}
function richViewChannel(value, session, kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.prototype.hasOwnProperty.call(RICH_VIEW_SHAPES, kind)) return false;
  if (!RICH_VIEW_SHAPES[kind].includes(Object.keys(value).sort().join(',')) || value.schemaVersion !== 1 || value.kind !== kind || value.session !== session) return false;
  if (richViewBytes(value) > RICH_VIEW_LIMIT + 16384) return false;
  const id = () => Number.isSafeInteger(value.id) && value.id >= 1;
  switch (kind) {
    case 'post': return id();
    case 'call': return id() && typeof value.path === 'string' && value.path.length <= 64 && /^[A-Za-z]+(\.[A-Za-z]+){1,2}$/.test(value.path) && Array.isArray(value.args) && value.args.length <= 4;
    case 'focus': return typeof value.focused === 'boolean';
    case 'reply': return id() && typeof value.ok === 'boolean' && (value.ok ? !('error' in value) : !!value.error && typeof value.error === 'object' && typeof value.error.code === 'string');
    case 'visibility': return typeof value.visible === 'boolean' && (value.focused === undefined || typeof value.focused === 'boolean');
    case 'theme': return richViewTheme(value.theme);
    default: return true;
  }
}
