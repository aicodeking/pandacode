#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { install, supportedPlatforms } from '../installer.mjs';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: npx pandacode [--dry-run] [--help] [--version]

Downloads the latest PandaCode release from GitHub, verifies its signature and
installs it (${supportedPlatforms().join(', ')}).

  --dry-run   download and verify only
  --version   print this installer's version`);
} else if (args.includes('--version') || args.includes('-v')) {
  console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
} else {
  install({ dryRun: args.includes('--dry-run') }).catch(error => {
    console.error(`pandacode: ${error.message}`);
    process.exit(1);
  });
}
