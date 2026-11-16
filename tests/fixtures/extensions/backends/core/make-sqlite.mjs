// Fixture values shared by file tests and a browser preview, without Node imports.
export function databaseRows(count = 250) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 10000) throw new Error('rows must be between 1 and 10000');
  return Array.from({ length: count }, (_, i) => ({ id: i + 1, title: `Track ${i + 1}`, minutes: (i % 7) + 0.5, cover: i === 0 ? new Uint8Array(1200).fill(42) : new Uint8Array(), plays: i === 0 ? 9007199254740993n : BigInt(i) }));
}
