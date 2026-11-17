// R0806 fixture: a service that signs in through the host's browser flow (fake identity server B3 and fake browser B4
// in the native tests), keeps its token in its own secrets and publishes what is true with `panda.providers.update`:
// ready models, an account label and limits after sign-in; signed out, no models and no limits after sign-out.
// No credential is ever placed in a published value.
const { createHash, randomBytes } = require('node:crypto');

const PROVIDER = 'sample.provider-state/agent';
const SIGNED_OUT = { readiness: { state: 'signedOut', reason: 'Sign in to use the fixture provider.' } };

exports.service = async (panda, lifetime) => {
  const identity = () => process.env.PANDA_FIXTURE_IDENTITY || 'http://127.0.0.1:1';
  panda.commands.register('sample.provider-state/sign-in', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(12).toString('base64url');
    const result = await panda.auth.signIn({
      authorizeUrl: `${identity()}/authorize?response_type=code&client_id=sample&redirect_uri={redirect_uri}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256&scope=read`,
      callback: { path: '/callback' }, timeoutMs: 120000, title: 'Fixture account',
    });
    if (result.status !== 'completed') { await panda.providers.update(PROVIDER, SIGNED_OUT); return; }
    const callback = new URL(result.url);
    if (callback.searchParams.get('state') !== state) { await panda.providers.update(PROVIDER, SIGNED_OUT); return; }
    const response = await fetch(`${identity()}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: callback.searchParams.get('code') || '', client_id: 'sample', redirect_uri: result.redirectUri, code_verifier: verifier }),
    });
    const token = await response.json();
    await panda.secrets.set({ key: 'access-token', value: token.access_token });
    await panda.providers.update(PROVIDER, {
      readiness: { state: 'ready', reason: 'Signed in as Fixture User.' },
      account: { label: 'Fixture User' },
      models: [
        { id: 'fixture-large', name: 'Fixture large', efforts: ['low', 'high'], contextWindow: 200000, speedTiers: [{ id: 'fast', name: 'Fast' }] },
        { id: 'fixture-small', name: 'Fixture small', efforts: [] },
      ],
      limits: { windows: [{ id: 'session', label: 'Session', usedPercent: 12.5, resetsAt: '2026-11-17T12:00:00Z' }] },
    });
    await lifetime.setStatus({ text: 'signed in' });
  });
  panda.commands.register('sample.provider-state/sign-out', async () => {
    await panda.secrets.delete({ key: 'access-token' });
    await panda.providers.update(PROVIDER, SIGNED_OUT);
    await lifetime.setStatus({ text: 'signed out' });
  });
};
