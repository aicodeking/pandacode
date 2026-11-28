/* Pure metadata helpers for changelog release entries (no Vite glob or JSON imports
 * so Node unit tests can import this module directly). */

/** Release notes that were not published as standalone GitHub Releases, mapped to the release they shipped in. */
export const UNPUBLISHED_BUNDLED_IN: Record<string, string> = {
  '0.3.160': '0.3.161',
  '0.3.159': '0.3.161',
  '0.3.155': '0.3.156',
  '0.3.153': '0.3.154',
  '0.3.143': '0.3.144',
  '0.3.141': '0.3.142',
  '0.3.118': '0.3.119',
  '0.3.117': '0.3.119',
  '0.3.116': '0.3.119',
  '0.3.115': '0.3.119',
  '0.3.95': '0.3.96',
  '0.3.58': '0.3.59',
  '0.3.36': '0.3.37',
};

const UNPUBLISHED_VERSIONS = new Set(['0.3.72', '0.3.124']);

export type PublicationStatus = 'published' | 'bundled' | 'pre-public' | 'unpublished';

export function bundledInVersion(version: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(UNPUBLISHED_BUNDLED_IN, version)
    ? UNPUBLISHED_BUNDLED_IN[version]
    : undefined;
}

export function publicationStatus(version: string): PublicationStatus {
  if (/^0\.2\.\d+$/.test(version)) return 'pre-public';
  if (bundledInVersion(version)) return 'bundled';
  if (UNPUBLISHED_VERSIONS.has(version)) return 'unpublished';
  return 'published';
}

export function publishedReleaseSummary<T extends { version: string; bundledIn?: string }>(
  releases: readonly T[],
): { latest: T | undefined; publishedCount: number } {
  const published = releases.filter(release => !release.bundledIn && publicationStatus(release.version) === 'published');
  return { latest: published[0], publishedCount: published.length };
}
