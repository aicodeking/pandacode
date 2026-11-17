/* Synthetic fault canaries for the mount tests: a panel that throws and a panel that never yields. */
pandaView.onDidInitialize(({ dto }) => {
  document.getElementById('board').textContent = `${dto.owner} ${dto.version}: ${dto.title}`;
  document.getElementById('placement').textContent = `mount: ${dto.windowId}`;
});
document.getElementById('throw').addEventListener('click', () => { setTimeout(() => { throw new Error('board fault canary'); }, 0); });
document.getElementById('loop').addEventListener('click', () => { for (;;) { /* never yields: the host must stay responsive */ } });
