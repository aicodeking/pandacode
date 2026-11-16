// Parse a tool invocation into daemon operations, without Node or a shell.
export function cliOperation(argv) {
  const flags = {}, words = [];
  for (const item of argv) {
    if (item.startsWith('--')) {
      const at = item.indexOf('=');
      if (at < 3) throw new Error(`Expected --name=value: ${item}`);
      flags[item.slice(2, at)] = item.slice(at + 1);
    } else words.push(item);
  }
  const command = words.shift(), id = flags.id;
  const require_ = (...names) => { for (const name of names) if (!flags[name]) throw new Error(`Missing --${name}`); };
  if (command === 'version') return { op: 'hello', project: value => value };
  if (['list', 'ready', 'blocked'].includes(command)) return { op: 'issues.snapshot', project(value) {
    if (command === 'list') return value.issues.filter(x => !flags.status || x.status === flags.status);
    return value.issues.filter(x => value[`${command}Ids`].includes(x.id));
  } };
  if (command === 'create') { require_('title'); return { op: 'issues.create', params: { title: flags.title, type: flags.type ?? 'task', priority: flags.priority === undefined ? 2 : Number(flags.priority) } }; }
  if (command === 'dep' && words[0] === 'add' && words.length === 3) return { op: 'deps.add', params: { id: words[1], dependsOn: words[2] } };
  if (command === 'comment' && words.length >= 2) return { op: 'comments.add', params: { id: words[0], text: words.slice(1).join(' ') } };
  if (['show', 'update', 'claim', 'close', 'reopen'].includes(command)) {
    require_('id');
    if (command === 'claim') require_('actor');
    const params = { id };
    if (command === 'update') params.patch = Object.fromEntries(['status', 'assignee', 'title'].filter(key => flags[key] !== undefined).map(key => [key, flags[key]]));
    if (command === 'claim') params.actor = flags.actor;
    if (flags.reason !== undefined) params.reason = flags.reason;
    if (flags['if-revision'] !== undefined) {
      params.ifRevision = Number(flags['if-revision']);
      if (!Number.isInteger(params.ifRevision)) throw new Error('Invalid revision');
    }
    return { op: `issues.${command === 'show' ? 'get' : command}`, params };
  }
  throw new Error(`Unknown or incomplete command: ${command ?? ''}`);
}
