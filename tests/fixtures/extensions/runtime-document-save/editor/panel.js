// R0902 fixture panel: shows the host buffer and follows what the host does to it around a save.
(async () => {
  const doc = pandaView.document;
  const area = document.getElementById('buffer');
  const status = document.getElementById('status');
  const state = await doc.read();
  area.value = state.text;
  area.addEventListener('input', () => doc.edit({ text: area.value }));
  // Deliver a pending edit before the host saves; the host waits at most 1 s and saves either way.
  doc.onWillSave(async () => { if (!doc.readOnly) await doc.edit({ text: area.value }); });
  // Replacements and saved revisions arrive in order: a formatter's rewrite ('format'), a disk change, a revert, a save.
  doc.onDidReplace(next => { area.value = next.text; status.textContent = 'replaced (' + next.reason + ') at ' + next.revision; });
  doc.onDidSave(info => { status.textContent = 'saved ' + info.revision; });
  document.getElementById('save')?.addEventListener('click', () => doc.save());
})();
