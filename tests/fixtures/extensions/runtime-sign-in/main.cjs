// R0803 fixture: a service that signs in through the host's browser flow (permission `auth.signIn`) and keeps the
// token it obtains in its own secrets (`secrets.private`). The host returns the whole callback address; checking the
// state value, the proof key and the code exchange are this package's (the host never interprets the query).
const { createHash, randomBytes } = require('node:crypto');

exports.service = async (panda, lifetime) => {
  panda.commands.register('sample.sign-in/connect', async () => {
    const identity = process.env.PANDA_FIXTURE_IDENTITY || 'http://127.0.0.1:1';
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(12).toString('base64url');
    const result = await panda.auth.signIn({
      authorizeUrl: `${identity}/authorize?response_type=code&client_id=sample&redirect_uri={redirect_uri}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256&scope=read`,
      callback: { path: '/callback' },
      timeoutMs: 120000,
      manual: true,
      title: 'Sample cloud',
    });
    if (result.status !== 'completed') { await lifetime.setStatus({ text: `sign-in ${result.status}` }); return; }
    const callback = new URL(result.url);
    if (callback.searchParams.get('state') !== state) { await lifetime.setStatus({ text: 'sign-in refused: wrong state' }); return; }
    const response = await fetch(`${identity}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: callback.searchParams.get('code') || '', client_id: 'sample', redirect_uri: result.redirectUri, code_verifier: verifier }),
    });
    const token = await response.json();
    await panda.secrets.set({ key: 'access-token', value: token.access_token });
    await lifetime.setStatus({ text: 'signed in' });
  });
};
