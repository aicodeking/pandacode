import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import {
  UNPUBLISHED_BUNDLED_IN,
  bundledInVersion,
  publishedReleaseSummary,
} from '../website/src/lib/changelog-meta.ts';

async function releaseNoteVersions() {
  return (await readdir(new URL('../releases/', import.meta.url)))
    .filter(name => /^\d+\.\d+\.\d+\.md$/.test(name))
    .map(name => name.slice(0, -3));
}

test('releases/0.3.155.md has no dead v0.3.155 URLs and documents shipping bundled in v0.3.156', async () => {
  const notes = await readFile(new URL('../releases/0.3.155.md', import.meta.url), 'utf8');
  const urls = notes.match(/https?:\/\/[^\s)]+/g) ?? [];

  assert.ok(urls.length >= 5, 'expected release tag, benchmark, migration, and SBOM links');
  assert.deepEqual(
    urls.filter(url => url.includes('v0.3.155')),
    [],
    'releases/0.3.155.md must not link to unpublished v0.3.155 URLs',
  );
  assert.match(notes, /not published as a (?:separate|standalone) GitHub Release/i);
  assert.ok(
    urls.includes('https://github.com/aicodeking/pandacode/releases/tag/v0.3.156'),
    'should link to the published v0.3.156 release tag',
  );
  assert.ok(
    urls.includes('https://github.com/aicodeking/pandacode/blob/v0.3.156/docs/db-benchmarks.md'),
    'should link to docs/db-benchmarks.md at v0.3.156',
  );
  assert.ok(
    urls.includes('https://github.com/aicodeking/pandacode/blob/v0.3.156/docs/db-benchmarks.md#7-migration-at-two-scales'),
    'should link to migration timings at v0.3.156',
  );
  assert.ok(
    urls.includes('https://github.com/aicodeking/pandacode/releases/download/v0.3.156/SBOM-COVERAGE.json'),
    'should link to SBOM-COVERAGE.json from v0.3.156',
  );
  assert.ok(
    urls.includes('https://github.com/aicodeking/pandacode/releases/download/v0.3.156/SBOM-COVERAGE.md'),
    'should link to SBOM-COVERAGE.md from v0.3.156',
  );
});

test('bundledInVersion identifies unpublished rolled-up release notes only', async () => {
  assert.equal(bundledInVersion('0.3.160'), '0.3.161');
  assert.equal(bundledInVersion('0.3.159'), '0.3.161');
  assert.equal(bundledInVersion('0.3.155'), '0.3.156');
  assert.equal(bundledInVersion('0.3.153'), '0.3.154');
  assert.equal(bundledInVersion('0.3.143'), '0.3.144');
  assert.equal(bundledInVersion('0.3.141'), '0.3.142');
  for (const patch of [115, 116, 117, 118]) {
    assert.equal(bundledInVersion(`0.3.${patch}`), '0.3.119');
  }
  assert.equal(bundledInVersion('0.3.95'), '0.3.96');
  assert.equal(bundledInVersion('0.3.58'), '0.3.59');
  assert.equal(bundledInVersion('0.3.36'), '0.3.37');

  assert.equal(bundledInVersion('0.3.162'), undefined);
  assert.equal(bundledInVersion('0.3.161'), undefined);
  assert.equal(bundledInVersion('0.3.156'), undefined);
  assert.equal(bundledInVersion('0.3.154'), undefined);
  assert.equal(bundledInVersion('0.3.144'), undefined);
  assert.equal(bundledInVersion('0.3.142'), undefined);
  assert.equal(bundledInVersion('toString'), undefined);
  assert.equal(bundledInVersion('constructor'), undefined);

  const releaseFiles = new Set(await releaseNoteVersions());
  for (const [unpublished, target] of Object.entries(UNPUBLISHED_BUNDLED_IN)) {
    assert.ok(releaseFiles.has(unpublished), `missing release note for unpublished ${unpublished}`);
    assert.ok(releaseFiles.has(target), `missing release note for target ${target}`);
    assert.equal(bundledInVersion(target), undefined, `target ${target} must be a published release`);
    assert.equal(publishedReleaseSummary([{ version: target }]).publishedCount, 1, `target ${target} must be published`);
    const note = await readFile(new URL(`../releases/${unpublished}.md`, import.meta.url), 'utf8');
    const urls = note.match(/https?:\/\/[^\s)]+/g) ?? [];
    assert.deepEqual(
      urls.filter(url => url.includes(`/releases/download/v${unpublished}/`)),
      [],
      `releases/${unpublished}.md must not link to unpublished v${unpublished} release assets`,
    );
    if (unpublished !== '0.3.153') {
      assert.deepEqual(
        urls.filter(url => url.includes(`/blob/v${unpublished}/`)),
        [],
        `releases/${unpublished}.md must not link to untagged v${unpublished} blob URLs`,
      );
    }
  }
});

test('publishedReleaseSummary excludes unpublished entries from latest and count', () => {
  const leadingUnpublished = [
    { version: '0.3.155', bundledIn: bundledInVersion('0.3.155') },
    { version: '0.3.154', bundledIn: bundledInVersion('0.3.154') },
    { version: '0.3.153', bundledIn: bundledInVersion('0.3.153') },
    { version: '0.3.152', bundledIn: bundledInVersion('0.3.152') },
  ];
  assert.deepEqual(publishedReleaseSummary(leadingUnpublished), {
    latest: leadingUnpublished[1],
    publishedCount: 2,
  });

  const publishedTop = [
    { version: '0.3.156', bundledIn: bundledInVersion('0.3.156') },
    { version: '0.3.155', bundledIn: bundledInVersion('0.3.155') },
    { version: '0.3.154' },
  ];
  assert.deepEqual(publishedReleaseSummary(publishedTop), {
    latest: publishedTop[0],
    publishedCount: 2,
  });

  const customBundled = [
    { version: '0.9.1', bundledIn: '0.9.2' },
    { version: '0.9.0' },
  ];
  assert.deepEqual(publishedReleaseSummary(customBundled), {
    latest: customBundled[1],
    publishedCount: 1,
  });

  assert.deepEqual(publishedReleaseSummary([{ version: '0.3.155', bundledIn: '0.3.156' }]), {
    latest: undefined,
    publishedCount: 0,
  });
  assert.deepEqual(publishedReleaseSummary([]), {
    latest: undefined,
    publishedCount: 0,
  });
});

test('every historical unpublished note is excluded even without a bundledIn field', async () => {
  const noteVersions = new Set(await releaseNoteVersions());
  const versions = [
    ...Array.from({ length: 49 }, (_, patch) => `0.2.${patch}`),
    ...[36, 58, 72, 95, 115, 116, 117, 118, 124, 141, 143, 153, 155, 159, 160].map(patch => `0.3.${patch}`),
  ];
  for (const version of versions) {
    assert.ok(noteVersions.has(version), `missing release note for ${version}`);
    assert.deepEqual(publishedReleaseSummary([{ version }]), {
      latest: undefined,
      publishedCount: 0,
    }, `${version} must be excluded`);
  }
});

test('repository notes match the published release totals through 0.3.164', async () => {
  const compare = (a, b) => a.localeCompare(b, 'en', { numeric: true });
  const versions = (await releaseNoteVersions()).sort((a, b) => compare(b, a));
  for (const [version, publishedCount] of [['0.3.162', 143], ['0.3.163', 144], ['0.3.164', 145]]) {
    const releases = versions.filter(note => compare(note, version) <= 0).map(version => ({ version }));
    assert.deepEqual(publishedReleaseSummary(releases), { latest: { version }, publishedCount });
  }
});
