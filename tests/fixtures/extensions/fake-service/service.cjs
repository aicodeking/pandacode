// Explicit local test fixture only. Never loaded by the extension or app startup.
const { createServer } = require('node:http');
function service() {
  return createServer((request, response) => {
    const credential = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (request.url === '/wait') return;
    if (request.url === '/redirect') { response.writeHead(302, { Location: 'https://unauthorized.example/summary' }); response.end(); return; }
    if (request.url === '/large') { response.end('x'.repeat(32769)); return; }
    if (request.url === '/failure') { response.writeHead(401); response.end(credential); return; }
    if (request.url !== '/summary') { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ accepted: !!credential, count: 3, echo: credential }));
  });
}
module.exports = { service };
if (require.main === module) {
  const server = service(); server.listen(19473, '127.0.0.1', () => console.log('Fake service listening on http://127.0.0.1:19473 (manual fixture only)'));
  process.on('SIGINT', () => { server.closeAllConnections(); server.close(); });
}
