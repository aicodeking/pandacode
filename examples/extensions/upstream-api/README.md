# Upstream API provider (experimental API 1)

An API-backed provider package, exercised against a fake loopback service. ZIP only `package/extension.json` and
`package/main.cjs` at the archive root, install it in Settings > Extensions > Install local package, review the executable
trust, enable it and approve its permissions (`runtime.service`, `connections.request`, `secrets.private`). Run **Store
the fake API key** once, then pick **Fake chat API > Fixture small > Standard** in the model picker and send a prompt.

The full walk-through (grant and revoke, failures, runtime prerequisites, the platform gaps) is in
[docs/extensions/examples/upstream-api-tools.md](../../../docs/extensions/examples/upstream-api-tools.md).

The manifest address `http://127.0.0.1:9/...` is a placeholder: the spec rewrites it to its own loopback port. To try it
by hand, run any local JSON service and change the two `url` values to its numeric loopback address. Only `https` or a
numeric loopback `http` address is accepted. The key is the fake canary `tok-fake-upstream-api-key`; the package never reads
a credential PandaCode holds, and no live external inference is made.
