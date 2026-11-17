'use strict';
// A package with tool servers needs no handler of its own: the servers are launched by the host from `server/`.
exports.service = async () => {};
exports.commands = { 'sample.docs/control': async () => ({ ok: true }) };
