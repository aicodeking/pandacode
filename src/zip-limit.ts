// Kept apart from the viewer so it can be tested without the browser.
const UNZIPPED_BYTES = 512 * 1024 * 1024;

/**
 * Word and modern spreadsheet files are zip archives; a tiny one can claim gigabytes once unpacked.
 * The central directory lists every entry's unpacked size, so the total is checked before parsing.
 * Files that are not zips (.xls) pass through to their own parser.
 */
export function checkUnzippedSize(bytes: ArrayBuffer): void {
  const view = new DataView(bytes);
  let end = -1;
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 65_557); i--) if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) return;
  const entries = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true), total = 0;
  for (let n = 0; n < entries; n++) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) throw new Error('The file is damaged.');
    const size = view.getUint32(offset + 24, true);
    // 0xFFFFFFFF means a ZIP64 size, which no document this viewer opens needs.
    if (size === 0xffffffff || (total += size) > UNZIPPED_BYTES) throw new Error('The file unpacks to more than 512 MB.');
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
}
