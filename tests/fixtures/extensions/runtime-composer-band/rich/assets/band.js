// The band panel names its package and the placement the host reports ('band').
pandaView.onDidInitialize(({ dto }) => {
  document.getElementById('band').textContent = `${dto.owner}: ${dto.title} (${dto.placement ?? 'band'})`;
});
