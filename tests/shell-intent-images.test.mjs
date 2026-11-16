// Producer parity: describeShell(command).producedImage must match the shared fixture that Rust also satisfies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// dom.ts's fileIcon reads the theme once its lazy icon chunk has loaded.
globalThis.document ??= { documentElement: { dataset: {} } };
import { describeShell } from '../src/shell-intent.ts';

const CASES = JSON.parse(readFileSync(new URL('./fixtures/produced-images.json', import.meta.url), 'utf8'));
const produced = (command, cwd) => describeShell(command, undefined, cwd ? { cwd } : undefined).producedImage ?? null;
/** Producer checks run in a known working directory, so relative outputs are located (`out.png` → `/w/out.png`). */
const WORKDIR = '/w';
const inWorkdir = command => produced(command, WORKDIR);
const located = path => path && !/^[/~]/.test(path) ? `${WORKDIR}/${path.replace(/^\.\//, '')}` : path;

test('every shared fixture case produces the same image as Rust', () => {
  assert.ok(CASES.length > 20);
  for (const { command, cwd, produced: expected } of CASES) {
    // `cwd` is the record's working directory (Codex `Working directory`, Devin `workdir`); without one a relative output is unknown.
    assert.equal(produced(command, cwd), expected, `${command} (cwd ${cwd ?? 'none'})`);
  }
});

test('formats the viewer cannot decode never produce a thumbnail', () => {
  for (const command of ['screencapture /tmp/a.tiff', 'screencapture /tmp/a.tif', 'sips -s format bmp a.png --out a.bmp',
    'magick a.png b.heic', 'convert a.png b.HEIC', 'ffmpeg -i in.mp4 -frames:v 1 f.bmp']) {
    assert.equal(produced(command), null, command);
  }
});

test('readers, inspectors and pattern outputs are not producers', () => {
  for (const command of ['magick identify a.png', 'identify a.png', 'magick identify -verbose shot.jpg', 'sips -g pixelWidth a.png',
    'ffmpeg -i in.png', 'ffmpeg -i in.mp4 out_%d.png', 'file a.png', 'open a.png', 'cp a.png b.png']) {
    assert.equal(produced(command), null, command);
  }
});

test('simulators, playwright, in-place sips and ffmpeg with trailing flags produce', () => {
  const cases = {
    'xcrun simctl io booted screenshot /tmp/sim.png': '/tmp/sim.png',
    'xcrun simctl io booted screenshot --type=jpeg --mask=black s.jpg': 's.jpg',
    'npx playwright screenshot https://example.com /tmp/page.png': '/tmp/page.png',
    'playwright screenshot --full-page http://localhost:3000 home.png': 'home.png',
    'sips -Z 100 a.png': 'a.png',
    'ffmpeg -i in.mp4 -frames:v 1 thumb.jpg -y': 'thumb.jpg',
    'ffmpeg -y -i in.mp4 -frames:v 1 -loglevel error thumb.webp': 'thumb.webp',
    // As in tool_images_auth/shell.rs: an unknown option takes the next word only when it is no path or option.
    'ffmpeg -noautorotate -i in.png out.png': 'out.png',
    'ffmpeg -update 1 -i in.mp4 frame.png': 'frame.png',
    'ffmpeg -i in.mp4 -noautoscale out.png': 'out.png',
  };
  for (const [command, expected] of Object.entries(cases)) assert.equal(inWorkdir(command), located(expected), command);
});

test('timeout, nice, caffeinate, sudo and env prefixes reach the producer', () => {
  const cases = {
    'timeout 10 screencapture -x /tmp/t.png': '/tmp/t.png',
    'timeout -s KILL 5s screencapture /tmp/t.png': '/tmp/t.png',
    'gtimeout --preserve-status 5 screencapture /tmp/g.png': '/tmp/g.png',
    'nice -n 10 ffmpeg -i a.mp4 -frames:v 1 n.png': 'n.png',
    'nice ffmpeg -i a.mp4 -frames:v 1 n.png': 'n.png',
    'caffeinate -i screencapture /tmp/c.png': '/tmp/c.png',
    'caffeinate -dims screencapture /tmp/c.png': '/tmp/c.png',
  };
  for (const [command, expected] of Object.entries(cases)) assert.equal(inWorkdir(command), located(expected), command);
});

test('relative outputs resolve against an absolute cd or the given working directory, else are unknown', () => {
  assert.equal(produced('cd /tmp/x && screencapture a.png'), '/tmp/x/a.png');
  assert.equal(produced('cd /tmp/x && cd sub && screencapture ./a.png'), '/tmp/x/sub/a.png');
  assert.equal(produced('cd /tmp/x && screencapture /tmp/y/a.png'), '/tmp/y/a.png');
  // Claude's Bash records carry no working directory and the agent's cwd persists between calls: a relative output can't be located.
  for (const command of ['ffmpeg -y -i in.mp4 -frames:v 1 intro.jpg', 'cd sub; cd deeper && screencapture ./a.png', 'cd "$DIR" && screencapture a.png',
    'screencapture -x shot.png', 'curl -s https://e.com/a.png > a.png']) {
    assert.equal(produced(command), null, command);
  }
  assert.equal(produced('ffmpeg -y -i in.mp4 -frames:v 1 intro.jpg', '/repo'), '/repo/intro.jpg');
  assert.equal(produced('cd sub; cd deeper && screencapture ./a.png', '/repo/'), '/repo/sub/deeper/a.png');
  assert.equal(produced('cd "$DIR" && screencapture a.png', '/repo'), null);
  // `~` depends on whose home: never located, with or without a working directory.
  assert.equal(produced('screencapture ~/shot.png', '/repo'), null);
  assert.equal(produced('cd ~/work && screencapture shot.png', '/repo'), null);
  assert.equal(produced('ffmpeg -i a.mp4 out.png', 'relative/dir'), null);
  assert.equal(produced('(cd "$DIR" && ls); screencapture a.png', '/repo'), '/repo/a.png');
  // Codex records name the directory on their last line.
  assert.equal(produced('/bin/zsh -lc "sips -Z 400 big.png --out small.png"\nWorking directory: /Users/me/repo'), '/Users/me/repo/small.png');
});

test('stdout, in-place edits, downloads, leading --out and dead steps', () => {
  const cases = {
    'magick convert in.png -strip -': null,
    'convert in.png -resize 50% -': null,
    'magick in.png png:-': null,
    'mogrify -resize 50% x.png': 'x.png',
    'magick mogrify -resize 50% x.png': 'x.png',
    'magick convert in.png -strip out.png': 'out.png',
    'curl -o x.png https://e.com/a.png': 'x.png',
    'curl -sSL --output x.png https://e.com/a.png': 'x.png',
    'curl -o /dev/null https://e.com/a.png': null,
    'curl -o x.json https://e.com/a': null,
    'sips --out o.png in.png': 'o.png',
    'sips --out o.png -Z 100 in.png': 'o.png',
    'true || screencapture a.png': null,
    ': || screencapture a.png': null,
    'false && screencapture a.png': null,
    'true || screencapture a.png && screencapture b.png': 'b.png',
    'true && screencapture a.png': 'a.png',
  };
  for (const [command, expected] of Object.entries(cases)) assert.equal(inWorkdir(command), located(expected), command);
});

test('in-place mogrify reads as an edit of the image', () => {
  const intent = describeShell('mogrify -resize 50% shots/x.png');
  assert.equal(intent.verb, 'Resized image');
  assert.equal(intent.label, 'x.png');
  assert.equal(describeShell('magick convert in.png -strip -').verb, 'Converted');
  assert.equal(describeShell('magick convert in.png -strip -').label, 'in.png');
});

// Failed captures: the command exited 0 (`; echo sc=$?`), but the output says no image was written. Rust authorizes only
// completed records and never reads output, so these stay inline rather than in the shared fixture.
test('a capture whose output reports a failure makes no image and reads as failed', () => {
  const cases = [
    ['screencapture -x /tmp/full.png; echo sc=$?', 'could not create image from display\nsc=1'],
    ['screencapture -x /tmp/full.png; echo sc=$?', 'sc=1'],
    ['ffmpeg -y -i a.mp4 -frames:v 1 /tmp/o.png', '[image2 @ 0x1] Could not open file : /tmp/o.png\nError opening output file /tmp/o.png.\nConversion failed!'],
    ['sips -s format png a.heic --out /tmp/b.png', 'Error: Unable to render destination image'],
  ];
  for (const [command, output] of cases) {
    const intent = describeShell(command, output);
    assert.equal(intent.producedImage, undefined, command);
    assert.equal(intent.failed, true, command);
  }
  const ok = describeShell('screencapture -x /tmp/full.png; echo sc=$?', 'sc=0');
  assert.equal(ok.producedImage, '/tmp/full.png');
  assert.equal(ok.failed, undefined);
  // Without output nothing is known yet: the image stays (fixture parity).
  assert.equal(describeShell('screencapture -x /tmp/full.png; echo sc=$?').producedImage, '/tmp/full.png');
});
