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
      && !!theme && Object.keys(theme).sort().join(',') === 'colorScheme,schemaVersion'
      && theme.schemaVersion === 1 && ['dark', 'light'].includes(theme.colorScheme);
  } catch { return false; }
}
