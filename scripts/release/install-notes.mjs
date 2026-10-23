// The "Installing" section of a release's notes.
//
// A macOS build without a Developer ID carries an ad-hoc signature only. Gatekeeper
// refuses to open it, and "Open Anyway" in System Settings does not always clear that
// warning, so the notes name the step that does: removing the quarantine attribute a
// download leaves behind. A notarized build needs none of that, so the notes do not
// ask for it.
//
//   node scripts/release/install-notes.mjs [--signed]
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/// The command that clears the quarantine attribute on an installed app.
export const UNQUARANTINE = 'xattr -dr com.apple.quarantine /Applications/PandaCode.app';

/// What a macOS user is told before the app opens for the first time.
export function macosNote(signed) {
  if (signed) {
    return 'This build is signed and notarized, so macOS opens it without a warning.';
  }
  return [
    'This build is not signed with a Developer ID, so macOS refuses to open it the first',
    '  time, and **Open Anyway** in System Settings > Privacy & Security does not always',
    '  clear it. Run this once instead:',
    '',
    '  ```',
    `  ${UNQUARANTINE}`,
    '  ```',
    '',
    '  then open PandaCode again.',
  ].join('\n');
}

/// The whole "Installing" section, for a signed or an unsigned release.
export function installNotes({ signed = false } = {}) {
  return [
    '## Installing',
    '',
    '- **macOS (Apple silicon):** open `PandaCode-macOS-arm64.dmg` and drag PandaCode to Applications. ' + macosNote(signed),
    '- **macOS (Intel):** the same, with `PandaCode-macOS-x64.dmg`.',
    '- **Windows x64:** run `PandaCode-Windows-x64-setup.exe`. If SmartScreen warns about an unknown publisher, choose **More info > Run anyway**.',
    '- **Windows arm64:** run `PandaCode-Windows-arm64-setup.exe` (same SmartScreen step).',
    '- **Linux x64:** `chmod +x PandaCode-Linux-x86_64.AppImage` and run it.',
    '- **Linux arm64:** `chmod +x PandaCode-Linux-aarch64.AppImage` and run it.',
    '- **Any of the above, from a terminal:** `npx pandacode` downloads, verifies and installs the right build, and signs it locally on macOS, so no Gatekeeper warning appears.',
    '',
    'Each file has a `.sha256` checksum beside it. Installed copies update themselves from this page. Build from source: see CONTRIBUTING.md.',
    '',
  ].join('\n');
}

function main() {
  const signed = process.argv.slice(2).includes('--signed');
  process.stdout.write(installNotes({ signed }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
