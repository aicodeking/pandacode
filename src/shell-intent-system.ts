/* Shell-intent handlers for network, databases, processes, media and the system (curl, sqlite3, kill, ps, ffmpeg,
 * ImageMagick, sips, xcrun simctl, open, du, which, docker, tmux, sleep). Git and gh live in shell-intent-git.ts. */
import {
  basename, clip, desc, destroys, firstAndMore, flagValue, isFlag, isSubstitution, looseOperands, plural, positionals, set, trimTrailing, urlParts, withImage,
  type Desc, type Handler, type Segment, type ShellVerb,
} from './shell-intent-base.ts';
import { SEVERITY } from './shell-intent-risk.ts';

const same = (word: string) => word;
const isUrl = (word: string) => /^[a-z][\w+.-]*:\/\//i.test(word);

// ---------------------------------------------------------------- waits, network, databases

const sleep: Handler = (_program, args) => {
  const match = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(args[0] ?? '');
  if (!match) return desc('wait', 'Waited', 'sleep');
  const duration = `${match[1]}${match[2] || 's'}`;
  return desc('wait', 'Waited', duration, duration);
};

const CURL_FLAGS = set('-X', '-H', '-d', '-o', '-O', '-u', '-A', '-e', '-b', '-c', '-w', '-m', '-F', '-T', '-P', '--data', '--data-raw', '--data-binary', '--data-urlencode',
  '--header', '--request', '--output', '--user', '--user-agent', '--max-time', '--connect-timeout', '--retry', '--form', '--cookie', '--write-out');

/** A plain GET whose body is thrown away (`>/dev/null`, `-o /dev/null`) or only decides a condition (`if curl -s …; then`). */
function isProbe(args: string[], seg: Segment): boolean {
  const sends = args.some(arg => /^(?:-[dFT]|--data.*|--form|--upload-file|--json)$/.test(arg)) || !/^(?:GET|HEAD)?$/i.test(flagValue(args, ['-X', '--request']) ?? '');
  const text = seg.text ?? '';
  const discarded = /(?:^|\s)(?:1?>|&>)\s*\/dev\/null\b/.test(text) || flagValue(args, ['-o', '--output']) === '/dev/null';
  return !sends && (discarded || /^(?:if|elif|while|until)\s/.test(text));
}

/** `curl -o x.png URL`, `--output x.png`: the downloaded file is the image the step made. */
const fetchUrl: Handler = (program, args, seg) => {
  const url = args.find(isUrl) ?? positionals(args, CURL_FLAGS)[0];
  if (!url) return undefined;
  const parts = urlParts(url);
  if (parts && isProbe(args, seg)) return desc('fetch', 'Checked', parts[0], [parts[1], 'responds'].filter(Boolean).join(' '));
  // `curl -X DELETE …`, `--request DELETE`: removes whatever the URL names.
  const deletes = /^delete$/i.test(flagValue(args, ['-X', '--request']) ?? '');
  const fetched = desc('fetch', deletes ? 'Sent DELETE to' : 'Fetched', parts ? parts[0] : clip(url, 40), parts ? parts[1] : '');
  if (deletes) return { ...destroys(fetched, SEVERITY.other), reason: 'Deletes a remote resource' };
  return program === 'curl' ? withImage(fetched, flagValue(args, ['-o', '--output'])) : fetched;
};

const oneLine = (sql: string) => clip(sql.trim().replace(/\s+/g, ' '), 60);
const SQL_DANGER = /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA|INDEX|VIEW)|DELETE\s+FROM|TRUNCATE|FLUSHALL|FLUSHDB)\b/i;

const database: Handler = (program, args, seg) => {
  const sqlite = program === 'sqlite3' || program === 'sqlite' || program === 'duckdb';
  const [file = '', positional = ''] = sqlite ? positionals(args, set('-cmd', '-separator')) : [];
  // `file:kingcode.sqlite3?mode=ro`: the database's name, not its URI.
  const path = file.replace(/^file:(?:\/\/[^/]*)?/, '').replace(/\?.*$/, '');
  const name = sqlite ? clip(basename(path), 48) || program : flagValue(args, ['-d', '--dbname', '-D', '--database']) ?? program;
  const sql = sqlite ? positional : flagValue(args, ['-c', '--command', '-e', '--execute']) ?? (program === 'redis-cli' ? positionals(args, set('-h', '-p', '-n', '-a')).join(' ') : '');
  const statement = SQL_DANGER.exec(`${sql}\n${seg.body}`.slice(0, 20_000))?.[0];
  if (!statement) return desc('db', 'Queried', name, oneLine(sql));
  const severity = /^DROP|^FLUSH/i.test(statement) ? SEVERITY.tree : SEVERITY.other;
  const changed = destroys(desc('db', 'Changed database', name, oneLine(sql || seg.body)), severity, `${oneLine(statement).toUpperCase()} in ${name}`);
  return { ...changed, reason: sqlReason(statement) };
};

/** Why a statement is risky: `DROP TABLE` drops a table, `FLUSHALL` wipes every key. */
function sqlReason(statement: string): string {
  const upper = statement.toUpperCase();
  if (upper.startsWith('DROP')) return `Drops a ${upper.split(/\s+/)[1]?.toLowerCase() ?? 'table'}`;
  return upper.startsWith('FLUSH') ? 'Wipes a key-value store' : 'Deletes rows';
}

/** `dropdb -h localhost prod`: the whole database is gone. */
const dropdb: Handler = (_program, args) => {
  const [name] = positionals(args, set('-h', '-p', '-U', '--host', '--port', '--username', '--maintenance-db'));
  return name ? destroys(desc('db', 'Dropped database', clip(name, 48), '', 'trash'), SEVERITY.tree) : undefined;
};

// ---------------------------------------------------------------- processes and media

/** `kill -9`, `kill -KILL`, `kill -s SIGKILL`: no chance to clean up. */
const forceKill = (args: string[]) => args.some(arg => /^-(?:9|(?:SIG)?KILL)$/i.test(arg)) || /^(?:9|(?:SIG)?KILL)$/i.test(flagValue(args, ['-s', '-n']) ?? '');

/** `kill -9 -1`, `kill -- -1`: PID -1 signals every process the user may signal (a leading `-N`/`-NAME` is the signal). */
function signalsEveryProcess(args: string[]): boolean {
  const skip = args[0] === '-s' || args[0] === '-n' ? 2 : args[0]?.startsWith('-') && args[0] !== '--' ? 1 : 0;
  const pids = args.slice(skip);
  return (pids[0] === '--' ? pids.slice(1) : pids).includes('-1');
}
const everyProcess: Desc = { ...destroys(desc('process', 'Stopped', 'every process', '', 'stop'), SEVERITY.tree), reason: 'Kills every process you own' };

const kill: Handler = (program, args) => {
  if (program === 'kill') {
    const ids = positionals(args, set('-s', '-n')).filter(word => !isSubstitution(word));
    // `kill -0 PID` sends no signal: it only asks whether the process is still running.
    if (args.includes('-0') || /^0$/.test(flagValue(args, ['-s', '-n']) ?? '')) return desc('process', 'Checked', `process ${firstAndMore(ids, same)}`.trim(), 'is running', 'activity');
    if (signalsEveryProcess(args)) return everyProcess;
    const stopped = desc('process', 'Stopped', 'process', firstAndMore(ids, same), 'stop');
    return forceKill(args) ? destroys(stopped) : stopped;
  }
  // `pkill -f vite`, `killall node`: a polite stop by name; only a forced kill (`-9`, `-KILL`) loses work.
  const [name] = positionals(args, set('-u', '-U', '-g', '-G', '-P', '-s', '-t', '--signal'));
  // `pkill -u $USER`, `killall -u me`: no name, so every process the user runs.
  if (name === undefined && flagValue(args, ['-u', '-U']) !== undefined) return everyProcess;
  const stopped = desc('process', 'Stopped processes matching', name ? clip(name, 40) : 'process', '', 'stop');
  // `pkill -f .`, `pkill -f ''`: a pattern that matches every process stops the whole session, the agent's shell included.
  if (program === 'pkill' && name !== undefined && MATCHES_ALL.test(name)) return { ...destroys(stopped, SEVERITY.tree), reason: 'Stops every process' };
  return forceKill(args) ? destroys(stopped) : stopped;
};
/** pkill patterns (extended regexes) that match any process name or command line. */
const MATCHES_ALL = /^(?:|\.|\.\*|\.\+|\^|\$|\^\.\*\$?)$/;

const processes: Handler = (program, args) => {
  const operands = positionals(args, set('-p', '-u', '-c', '-g', '-o', '-O', '-U', '-G', '-s', '-P', '-d'));
  if (program === 'lsof') {
    // `lsof -i :1420` → `Checked open files [lsof] on :1420`; `lsof -p 123 -d cwd` names no port or file.
    const target = flagValue(args, ['-i']) ?? (operands[0] ? basename(operands[0]) : '');
    return desc('process', 'Checked open files', program, target ? `on ${clip(target, 48)}` : '', 'activity');
  }
  const object = program === 'pgrep' && operands[0] ? `matching ${operands[0]}` : '';
  return desc('process', 'Checked processes', program, clip(object, 48), 'activity');
};

/** ffmpeg options that take a value, by name before any `:stream` specifier (`-c:v`, `-q:v`), as in tool_images_auth/shell.rs. */
const FFMPEG_VALUED = set('-i', '-c', '-codec', '-vcodec', '-acodec', '-scodec', '-vf', '-af', '-filter', '-filter_complex', '-lavfi', '-ss',
  '-sseof', '-t', '-to', '-r', '-s', '-b', '-crf', '-preset', '-tune', '-profile', '-level', '-f', '-map', '-map_metadata', '-metadata',
  '-frames', '-vframes', '-aframes', '-pix_fmt', '-q', '-qscale', '-threads', '-loglevel', '-v', '-update', '-safe', '-aspect', '-ac', '-ar',
  '-g', '-movflags', '-vsync', '-fps_mode', '-itsoffset', '-framerate', '-video_size', '-start_number', '-stream_loop');
/** ffmpeg options known to take no value. */
const FFMPEG_FLAGS = set('-y', '-n', '-hide_banner', '-nostdin', '-stats', '-nostats', '-an', '-vn', '-sn', '-dn', '-shortest', '-re',
  '-benchmark', '-copyts');

/** A listed option takes a value; an unknown one only when the next word is plainly no path or option (`-update 1`,
 *  never `-noautorotate -i in.png`). */
function ffmpegTakesValue(option: string, next: string | undefined): boolean {
  const colon = option.indexOf(':');
  const name = colon < 0 ? option : option.slice(0, colon);
  if (FFMPEG_VALUED.has(name)) return true;
  return !FFMPEG_FLAGS.has(name) && next !== undefined && !next.startsWith('-') && !/[/.]/.test(next);
}

/** ffmpeg's last output: a word that is neither an option nor an option's value (an `-i` input is `-i`'s value). */
function ffmpegOutput(args: string[]): string | undefined {
  let output: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (isFlag(args[i])) { if (ffmpegTakesValue(args[i], args[i + 1])) i++; } else output = args[i];
  }
  return output === '-' ? undefined : output;
}

const ffmpeg: Handler = (program, args) => {
  const input = flagValue(args, ['-i']);
  const output = ffmpegOutput(args);
  if (program === 'ffprobe') return desc('media', 'Probed', clip(basename(input ?? output ?? 'media'), 48));
  if (!output) return desc('media', 'Encoded', input ? clip(basename(input), 48) : 'ffmpeg');
  return withImage(desc('media', 'Encoded', clip(basename(output), 48), input ? `from ${clip(basename(input), 48)}` : ''), output);
};

const screencapture: Handler = (_program, args) => {
  const files = positionals(args, set('-R', '-t', '-T', '-D', '-l', '-V', '-g'));
  const file = files[files.length - 1];
  return withImage(desc('media', 'Captured screenshot', file ? clip(basename(file), 48) : 'screen', '', 'camera'), file);
};

/** sips options and how many values each takes; any of SIPS_MODIFIERS rewrites the image (in place without `--out`). */
const SIPS_ARITY: Record<string, number> = {
  '-s': 2, '--setProperty': 2, '-g': 1, '--getProperty': 1, '-d': 1, '--deleteProperty': 1, '-z': 2, '--resampleHeightWidth': 2, '-Z': 1,
  '--resampleHeightWidthMax': 1, '--resampleWidth': 1, '--resampleHeight': 1, '-r': 1, '--rotate': 1, '-f': 1, '--flip': 1, '-c': 2,
  '--cropToHeightWidth': 2, '-p': 2, '--padToHeightWidth': 2, '-e': 1, '--embedProfile': 1, '-m': 1, '--matchTo': 1, '-o': 1, '--out': 1, '-i': 0,
};
const SIPS_MODIFIERS = set('-s', '--setProperty', '-d', '--deleteProperty', '-z', '--resampleHeightWidth', '-Z', '--resampleHeightWidthMax',
  '--resampleWidth', '--resampleHeight', '-r', '--rotate', '-f', '--flip', '-c', '--cropToHeightWidth', '-p', '--padToHeightWidth', '-e',
  '--embedProfile', '-m', '--matchTo');
const SIPS_RESIZE = /^(?:-[Zzcp]|--resample\w+|--cropToHeightWidth|--padToHeightWidth)$/;

function sipsImages(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (isFlag(args[i])) i += SIPS_ARITY[args[i]] ?? 0; else out.push(args[i]);
  }
  return out;
}

/** `sips -Z 800 a.png [--out b.png]` resizes (in place without `--out`), `-s format jpeg` converts, `-g pixelWidth` inspects. */
const sips: Handler = (_program, args) => {
  const image = sipsImages(args)[0];
  if (!image) return undefined;
  const out = flagValue(args, ['-o', '--out']);
  if (!args.some(arg => SIPS_MODIFIERS.has(arg))) {
    // `sips --out o.png in.png` writes a copy; with no `--out` it only reads.
    return out ? withImage(desc('media', 'Converted', clip(basename(out), 48), `from ${clip(basename(image), 48)}`, 'images'), out)
      : desc('media', 'Inspected', clip(basename(image), 48), '', 'images');
  }
  const format = args.some((arg, i) => /^(?:-s|--setProperty)$/.test(arg) && args[i + 1] === 'format');
  const into = out ? `→ ${clip(basename(out), 48)}` : '';
  const described = format && out ? desc('media', 'Converted', clip(basename(out), 48), `from ${clip(basename(image), 48)}`, 'images')
    : desc('media', args.some(arg => SIPS_RESIZE.test(arg)) ? 'Resized image' : 'Processed', clip(basename(image), 48), into, 'images');
  return withImage(described, out ?? image);
};

/** ImageMagick subcommands whose operand is an input, not an output. */
const MAGICK_READERS = set('identify', 'display');
const magickReader = (args: string[]): Desc => {
  const image = looseOperands(args)[0];
  return desc('media', 'Inspected', image ? clip(basename(image), 48) : 'image', '', 'images');
};

/** `mogrify -resize 50% x.png`, `magick mogrify …`: rewrites its images in place; the last one is the image it made. */
const mogrify = (args: string[]): Desc | undefined => {
  const files = looseOperands(args).filter(arg => !/^[\d.%x+-]+$/.test(arg));
  const image = files[files.length - 1];
  if (!image) return undefined;
  const verb = args.some(arg => /^[-+](?:resize|scale|sample|thumbnail|crop|extent|adaptive-resize)$/.test(arg)) ? 'Resized image' : 'Processed';
  return withImage(desc('media', verb, clip(basename(image), 48), files.length > 1 ? `+${plural(files.length - 1, 'file')}` : '', 'images'), image);
};

/** `magick convert in.png -strip -`, `… png:-`: the image goes to stdout, so no file is made. */
const TO_STDOUT = /^(?:[A-Za-z0-9]+:)?-$/;

/** `magick in.svg -resize 50% out.webp`, `convert a.png b.jpg`, `rsvg-convert -o icon.png icon.svg`: the last operand is written. */
const convertImage: Handler = (program, given) => {
  if (program === 'magick' && MAGICK_READERS.has(given[0] ?? '')) return magickReader(given.slice(1));
  if (program === 'mogrify' || (program === 'magick' && given[0] === 'mogrify')) return mogrify(program === 'mogrify' ? given : given.slice(1));
  // `magick convert …` is ImageMagick 7's spelling of `convert …`.
  const args = program === 'magick' && given[0] === 'convert' ? given.slice(1) : given;
  const last = args[args.length - 1] ?? '';
  if (program !== 'rsvg-convert' && TO_STDOUT.test(last)) {
    const input = looseOperands(args.slice(0, -1)).find(arg => !/^[\d.%x+-]+$/.test(arg));
    return desc('media', 'Converted', clip(basename(input ?? 'image'), 48), '→ stdout', 'images');
  }
  const named = program === 'rsvg-convert' ? flagValue(args, ['-o', '--output']) : undefined;
  const operands = program === 'rsvg-convert' ? positionals(args, set('-w', '-h', '-o', '-f', '-z', '-x', '-y', '-b', '--width', '--height', '--output', '--format'))
    : looseOperands(args).filter(arg => !/^[\d.%x+-]+$/.test(arg));
  // ImageMagick always writes its last argument (`-strip out.png`: an option without a value before it).
  const lastWritten = !named && !isFlag(last) && operands[0] && operands[0] !== last ? last : undefined;
  const output = named ?? lastWritten ?? (operands.length > 1 ? operands[operands.length - 1] : undefined);
  const input = named ? operands[0] : operands[0] === output ? undefined : operands[0];
  if (!output) return undefined;
  return withImage(desc('media', 'Converted', clip(basename(output), 48), input ? `from ${clip(basename(input), 48)}` : '', 'images'), output);
};

// ---------------------------------------------------------------- the system

const SIMCTL: Record<string, ShellVerb> = {
  boot: 'Booted simulator', shutdown: 'Shut down simulator', erase: 'Erased simulator', create: 'Created simulator', delete: 'Deleted simulator',
  install: 'Installed on simulator', uninstall: 'Uninstalled from simulator', launch: 'Launched on simulator', terminate: 'Stopped app on simulator',
  openurl: 'Opened on simulator', list: 'Listed simulators', io: 'Captured simulator screenshot', status_bar: 'Set simulator status bar',
  privacy: 'Set simulator privacy', push: 'Sent push to simulator', addmedia: 'Added media to simulator', ui: 'Set simulator appearance',
  get_app_container: 'Located app on simulator', spawn: 'Spawned on simulator',
};

function simctl(args: string[]): Desc {
  const [sub = '', ...rest] = positionals(args);
  const verb = sub === 'io' && args.includes('recordVideo') ? 'Recorded simulator video' : SIMCTL[sub] ?? 'Ran';
  const last = rest.filter(word => word !== 'booted' && word !== 'screenshot' && word !== 'recordVideo').pop() ?? '';
  // `simctl spawn booted log stream`: the command it runs on the device, not its last word.
  const object = sub === 'spawn' ? clip(rest.slice(1).join(' '), 60) : isUrl(last) ? clip(last, 60) : clip(basename(last), 48);
  const described = withImage(desc('system', verb, `simctl ${clip(sub, 24)}`.trim(), object, 'phone'), sub === 'io' ? last : undefined);
  // `simctl erase` wipes every app and its data from the simulator (`all`: from every simulator).
  return sub === 'erase' ? destroys(described, rest.includes('all') ? SEVERITY.tree : SEVERITY.discard) : described;
}

const xcrun: Handler = (_program, args, seg, recurse) => {
  const [tool] = positionals(args, set('--sdk', '--toolchain'));
  if (!tool) return undefined;
  const after = args.slice(args.indexOf(tool) + 1);
  return tool === 'simctl' ? simctl(after) : recurse(args.slice(args.indexOf(tool)), seg);
};

const open: Handler = (_program, args) => {
  const [target] = positionals(args, set('-a', '-b', '--args'));
  const app = flagValue(args, ['-a']);
  const parts = target && isUrl(target) ? urlParts(target) : undefined;
  if (parts) return desc('system', 'Opened', parts[0], parts[1], 'external');
  const label = target ? basename(target) : app ?? 'open';
  return desc('system', 'Opened', clip(label, 48), '', 'external');
};

const diskUsage: Handler = (program, args) => {
  const [path] = positionals(args, set('-d', '-B', '-t', '--max-depth', '--block-size'));
  return desc('system', 'Checked disk usage', path ? clip(basename(path), 48) : program);
};

const DIFF_VALUES = set('-U', '-C', '-x', '-X', '-I', '-F', '-L', '-D', '-W', '--unified', '--context', '--exclude', '--exclude-from',
  '--ignore-matching-lines', '--label', '--ifdef', '--show-function-line', '--width', '--from-file', '--to-file', '--color');
/** `a.txt`, `src/` → `src`; `<(git show HEAD:a.json)` → the command whose output is compared. */
const comparedName = (path: string) => isSubstitution(path)
  ? clip(path.replace(/^(?:[<>]\(|\$\()/, '').replace(/\)$/, '').trim(), 40) : clip(basename(trimTrailing(path, '/')) || path, 48);

/** `diff -u a.ts b.ts`, `cmp a b`: `Compared [a.ts] and b.ts`. */
const compare: Handler = (_program, args) => {
  const [first, second] = positionals(args, DIFF_VALUES);
  return first && second ? desc('read', 'Compared', comparedName(first), `and ${comparedName(second)}`) : undefined;
};

const locate: Handler = (_program, args) => {
  const names = positionals(args);
  return names.length ? desc('system', 'Located', firstAndMore(names, same), '', 'search') : undefined;
};

const DOCKER_VERBS: Record<string, ShellVerb> = {
  run: 'Ran container', ps: 'Listed containers', images: 'Listed images', logs: 'Viewed logs of', exec: 'Ran in container', pull: 'Pulled',
  push: 'Pushed', stop: 'Stopped', start: 'Started', restart: 'Restarted', rm: 'Removed', rmi: 'Removed image', kill: 'Stopped', inspect: 'Inspected',
  up: 'Started', down: 'Stopped', cp: 'Copied', tag: 'Tagged', login: 'Signed in to', build: 'Built',
};
const DOCKER_FLAGS = set('-p', '-v', '-e', '-w', '-u', '-l', '-f', '-t', '--name', '--network', '--env', '--env-file', '--entrypoint', '--mount',
  '--platform', '--label', '--add-host', '--user', '--workdir', '--volume', '--publish', '--memory', '--cpus', '--restart', '--tag', '--file',
  '--build-arg', '--target');
const DOCKER_GLOBAL = set('-H', '--context', '--config', '-f', '--file', '-p', '--project-name', '--profile', '--env-file');
const DOCKER_GROUPS = set('system', 'container', 'image', 'volume', 'network', 'builder');
const LOG_FLAGS = set('--tail', '--since', '--until', '-n');

/** Index of the subcommand at or after `from`, skipping global options. */
function subcommandAt(args: string[], from: number): number {
  let i = from;
  while (i < args.length && isFlag(args[i])) i += DOCKER_GLOBAL.has(args[i]) ? 2 : 1;
  return i;
}

const VOLUMES = 'Deletes container volumes';

const docker: Handler = (program, args) => {
  const first = subcommandAt(args, 0);
  const compose = program === 'docker-compose' || args[first] === 'compose';
  const i = compose && program !== 'docker-compose' ? subcommandAt(args, first + 1) : first;
  const sub = args[i] ?? '';
  const rest = positionals(args.slice(i + 1), sub === 'logs' ? LOG_FLAGS : DOCKER_FLAGS);
  const label = clip(`${compose ? 'docker compose' : 'docker'} ${sub}`.trim(), 40);
  if (sub === 'build') return desc('build', 'Built', label, firstAndMore(rest, same));
  const [action = '', ...targets] = rest;
  const volumes = sub === 'volume' ? { reason: VOLUMES, severity: SEVERITY.tree } : {};
  if (DOCKER_GROUPS.has(sub) && action === 'prune') return { ...destroys(desc('system', 'Cleaned', `${label} prune`, '', 'server')), ...volumes };
  if (DOCKER_GROUPS.has(sub) && action === 'rm') return { ...destroys(desc('system', 'Removed', `${label} rm`, firstAndMore(targets, same), 'server')), ...volumes };
  const described = desc('system', DOCKER_VERBS[sub] ?? 'Ran', label, firstAndMore(rest, same), 'server');
  // `docker compose down -v`: the named volumes (databases, caches) go with the containers.
  if (compose && sub === 'down' && args.slice(i + 1).some(arg => /^-[a-zA-Z]*v[a-zA-Z]*$/.test(arg) || arg === '--volumes')) {
    return { ...destroys(described, SEVERITY.tree), reason: VOLUMES };
  }
  return sub === 'rm' || sub === 'rmi' ? destroys(described) : described;
};

const TMUX_VALUES = set('-t', '-s', '-n', '-c', '-S', '-L', '-F', '-x', '-y', '-E');

/** `tmux capture-pane -t x`, `send-keys -t x "…" Enter`, `new-session -s x`. */
const tmux: Handler = (_program, args) => {
  const sub = positionals(args, set('-S', '-L', '-f'))[0] ?? '';
  const rest = args.slice(args.indexOf(sub) + 1);
  const target = flagValue(rest, ['-t']) ?? '';
  if (/^(?:capture-pane|capturep)$/.test(sub)) return desc('process', 'Viewed', 'tmux pane', clip(target, 40), 'terminal');
  if (/^(?:send-keys|send)$/.test(sub)) return desc('process', 'Sent keys to', target ? `tmux ${clip(target, 40)}` : 'tmux', clip(positionals(rest, TMUX_VALUES).join(' '), 60), 'terminal');
  if (/^(?:new-session|new)$/.test(sub)) return desc('process', 'Started', 'tmux session', clip(flagValue(rest, ['-s']) ?? '', 40), 'terminal');
  if (/^(?:kill-session|kill-server|kill-pane|kill-window)$/.test(sub)) return desc('process', 'Stopped', `tmux ${sub.slice(5)}`, clip(target, 40), 'stop');
  if (/^(?:ls|list-sessions|list-windows|list-panes)$/.test(sub)) return desc('process', 'Listed', 'tmux sessions', '', 'terminal');
  return undefined;
};

export const SYSTEM_HANDLERS: Record<string, Handler> = {
  tmux,
  sleep, curl: fetchUrl, wget: fetchUrl, http: fetchUrl, https: fetchUrl, xh: fetchUrl,
  sqlite3: database, sqlite: database, duckdb: database, psql: database, mysql: database, 'redis-cli': database, dropdb,
  kill, pkill: kill, killall: kill, ps: processes, lsof: processes, pgrep: processes,
  ffmpeg, ffprobe: ffmpeg, screencapture, sips, magick: convertImage, convert: convertImage, mogrify: convertImage, identify: (_program, args) => magickReader(args), 'rsvg-convert': convertImage, xcrun, open, du: diskUsage, diff: compare, colordiff: compare, cmp: compare, df: diskUsage,
  which: locate, whereis: locate, type: locate, command: locate, docker, 'docker-compose': docker,
};
