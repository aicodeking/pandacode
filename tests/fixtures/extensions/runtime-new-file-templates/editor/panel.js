// R0903 fixture panel: a plain text area bound to the host buffer through pandaView.document (the file the
// new-file item created from its template). The host owns the buffer and writes the file.
(async () => {
  const doc = pandaView.document;
  const area = document.getElementById('buffer');
  const status = document.getElementById('status');
  const show = state => { area.value = state.text ?? Array.from(new Uint8Array(state.bytes)).map(byte => byte.toString(16).padStart(2, '0')).join(' '); };
  show(await doc.read());
  area.readOnly = doc.readOnly || doc.encoding !== 'text';
  area.addEventListener('input', async () => {
    if (area.readOnly) return;
    const result = await doc.edit({ text: area.value });
    status.textContent = 'revision ' + result.revision;
  });
  doc.onDidReplace(state => { show(state); status.textContent = 'replaced (' + state.reason + ') at ' + state.revision; });
  doc.onWillSave(async () => { if (!area.readOnly) await doc.edit({ text: area.value }); });
  doc.onDidSave(info => { status.textContent = 'saved ' + info.revision; });
})();
