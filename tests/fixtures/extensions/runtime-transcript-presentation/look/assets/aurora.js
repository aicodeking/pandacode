// The backdrop panel names its package. A host fault (the spec induces one) never reaches the thread.
pandaView.onDidInitialize(({ dto }) => {
  document.getElementById('aurora').textContent = `${dto.owner}: ${dto.title}`;
});
