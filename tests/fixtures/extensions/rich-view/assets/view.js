/* Synthetic attack canaries, never user files, credentials or external endpoints. */
pandaView.onDidInitialize(({ dto, theme }) => {
  document.getElementById('report').textContent = `${dto.owner} ${dto.version}: ${dto.title}`;
  document.getElementById('theme').textContent = `Theme: ${theme.colorScheme}; window: ${dto.windowId}`;
});
document.getElementById('probe').addEventListener('click', async () => {
  const result = {};
  try { result.parentDom = !!parent.document.body; } catch { result.parentDom = false; }
  result.rawIpc = typeof window.__TAURI_INTERNALS__ !== 'undefined' || typeof window.__TAURI__ !== 'undefined';
  try { top.location.hash = 'extension-escaped'; result.topNavigation = true; } catch { result.topNavigation = false; }
  try { eval('1'); result.eval = true; } catch { result.eval = false; }
  try { await fetch('https://extension-invalid.example/canary'); result.network = true; } catch { result.network = false; }
  const remote = document.createElement('script'); remote.src = 'https://extension-invalid.example/canary.js'; document.body.append(remote);
  const image = document.createElement('img'); image.src = 'https://extension-invalid.example/canary.png'; document.body.append(image);
  document.getElementById('attacks').textContent = JSON.stringify(result);
});
