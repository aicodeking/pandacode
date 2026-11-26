// Writes the SideStore/AltStore source JSON for the PandaCode iPhone app. The mobile
// release workflow builds an unsigned IPA, attaches it to a GitHub Release tagged
// ios-v<version>, and runs this script so appstore/source.json names the newest build.
//
//   node scripts/release/mobile-source.mjs --repository owner/repo --version 1.0.0 \
//     --date 2026-11-26 --size 123456 --output appstore/source.json
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isMain } from './common.mjs';

export const BUNDLE_ID = 'com.aicodeking.pandacode';
export const SOURCE_ID = 'com.aicodeking.pandacode.source';
export const APP_NAME = 'PandaCode';

const DESCRIPTION = 'PandaCode lets you watch, steer and approve the coding agents running on '
  + 'your computers from your iPhone. It connects to the PandaCode desktop app through '
  + 'PandaCode Connect, so tasks keep running on your Mac or PC while you follow and answer '
  + 'them from your phone. The phone never runs or downloads code.';

const SCREENSHOTS = ['01-inbox', '02-task', '03-approval', '04-working'];

export function mobileSource({ repository, version, date, size, iconURL, screenshotURLs }) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository ?? '')) throw new Error('repository must be owner/repo.');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) throw new Error('version must be a stable SemVer such as 1.0.0.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) throw new Error('date must be YYYY-MM-DD.');
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('size must be a non-negative integer of bytes.');

  const raw = `https://raw.githubusercontent.com/${repository}/main`;
  const downloadURL = `https://github.com/${repository}/releases/download/ios-v${version}/PandaCode.ipa`;

  return {
    name: APP_NAME,
    identifier: SOURCE_ID,
    apps: [
      {
        name: APP_NAME,
        bundleIdentifier: BUNDLE_ID,
        developerName: APP_NAME,
        subtitle: 'Control your coding agents from your iPhone',
        localizedDescription: DESCRIPTION,
        iconURL: iconURL ?? `${raw}/mobile/assets/images/icon.png`,
        tintColor: '#111111',
        screenshotURLs: screenshotURLs ?? SCREENSHOTS.map(name => `${raw}/docs/app-store/screenshots/iphone-6.9/${name}.png`),
        versions: [
          {
            version,
            date,
            downloadURL,
            size,
          },
        ],
      },
    ],
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      version: { type: 'string' },
      date: { type: 'string' },
      size: { type: 'string' },
      output: { type: 'string' },
    },
  });
  for (const name of ['repository', 'version', 'date', 'size', 'output']) {
    if (!values[name]) throw new Error(`Missing --${name}.`);
  }
  const source = mobileSource({
    repository: values.repository,
    version: values.version,
    date: values.date,
    size: Number(values.size),
  });
  await writeFile(resolve(values.output), `${JSON.stringify(source, null, 2)}\n`);
  console.log(`Wrote ${values.output}: ${APP_NAME} ${values.version} (${values.size} bytes).`);
}

if (isMain(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
