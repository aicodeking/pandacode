// R0901 fixture panel: a plain text area bound to the host buffer through pandaView.document.
// The client script chunks the transfers; this page only sees whole text or an ArrayBuffer.
(async () => {
  const doc = pandaView.document;
  const area = document.getElementById('buffer');
  const status = document.getElementById('status');
  const show = state => { area.value = state.text ?? Array.from(new Uint8Array(state.bytes)).map(byte => byte.toString(16).padStart(2, '0')).join(' '); };
  show(await doc.read());
  area.readOnly = doc.readOnly;
  area.addEventListener('input', async () => {
    if (doc.readOnly) return;
    const result = await doc.edit({ text: area.value });
    status.textContent = 'revision ' + result.revision;
  });
  doc.onDidReplace(state => { show(state); status.textContent = 'replaced (' + state.reason + ') at ' + state.revision; });
  doc.onWillSave(async () => { if (!doc.readOnly && doc.encoding === 'text') await doc.edit({ text: area.value }); });
  doc.onDidSave(info => { status.textContent = 'saved ' + info.revision; });
})();
