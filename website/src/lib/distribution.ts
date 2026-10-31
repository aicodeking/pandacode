// Where PandaCode lives. Builds are published on GitHub Releases. macOS builds are signed with
// a Developer ID and notarized by Apple; update the Windows note once Authenticode signing lands.
const repoUrl = 'https://github.com/aicodeking/pandacode';

export const project = {
  repo: repoUrl,
  clone: `${repoUrl}.git`,
  releases: `${repoUrl}/releases/latest`,
  issues: `${repoUrl}/issues`,
  security: `${repoUrl}/security/policy`,
};

// Direct downloads: release assets keep these names, so /releases/latest/download/ always
// points at the newest build. Each has a matching .sha256 beside it.
const latest = `${repoUrl}/releases/latest/download`;
export const platformDownloads = [
  { label: 'macOS', detail: 'Apple silicon', href: `${latest}/PandaCode-macOS-arm64.dmg` },
  { label: 'macOS', detail: 'Intel', href: `${latest}/PandaCode-macOS-x64.dmg` },
  { label: 'Windows', detail: 'x64', href: `${latest}/PandaCode-Windows-x64-setup.exe` },
  { label: 'Windows', detail: 'arm64', href: `${latest}/PandaCode-Windows-arm64-setup.exe` },
  { label: 'Linux', detail: 'x86_64', href: `${latest}/PandaCode-Linux-x86_64.AppImage` },
  { label: 'Linux', detail: 'aarch64', href: `${latest}/PandaCode-Linux-aarch64.AppImage` },
] as const;

export const distribution = {
  platforms: 'macOS · Windows · Linux',
  hasNote: true,
  requirements: 'Apple silicon or Intel · macOS 12+',
  signingNotice: 'Signed and notarized by Apple.',
};
