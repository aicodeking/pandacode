# Sample cloud sign-in (experimental API 1, a package provider that signs in)

`sample.signin` is the reference for an account-backed provider: a trusted background service signs in through the host's
browser flow (`panda.auth.signIn`, permission `auth.signIn`), keeps its own tokens in the package's own secrets
(`secrets.private`), and publishes the account, the models and the limit windows with `panda.providers.update`
(`ui.dynamic`). The provider itself is a declared ACP harness (`launch`), so conversing needs no package code and the
launched program never receives a token. Full guide: [the sign-in provider](../../../docs/extensions/examples/signin.md).

```powershell
Compress-Archive -Path examples/extensions/signin/package/* -DestinationPath $env:TEMP/sample.signin.zip -Force
node --test tests/extensions-examples.test.mjs
```

Install, accept executable trust, enable, then allow the six permissions the install lists. Set the identity and API
addresses in Settings → Extensions → Sample cloud. The manifest's `__FAKE_AGENT__` stands for the ACP program to launch
(tests put the reusable fake agent there); replace it with your own CLI's ACP entry point. `lib/signin.mjs` is the whole
logic; `main.cjs` only starts it. For tests the fake identity and API (B3) and the fake browser (B4) play the cloud.
