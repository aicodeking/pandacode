// A stdio server that never answers: the host's handshake times out and the server is reported as failed.
process.stdin.resume();
setInterval(() => {}, 1000);
