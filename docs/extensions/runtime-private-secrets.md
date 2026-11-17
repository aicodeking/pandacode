# Private package secrets (`secrets.private`)

A trusted package that holds the `secrets.private` permission can keep its own secrets: an API token it was given,
a refresh token it obtained, a webhook signing key. The host stores them for the package and hands them back only
to that package's background service. It is runtime slice R0802.

```js
exports.service = async (panda, lifetime) => {
  await panda.secrets.set({ key: 'api-token', value: token });
  const { value } = await panda.secrets.get({ key: 'api-token' });   // string, or null when absent
  const { keys } = await panda.secrets.list();                       // ['api-token']
  await panda.secrets.delete({ key: 'api-token' });                  // idempotent
};
```

Types: `ServicePandaCode.secrets` in `src/extensions/sdk/index.d.ts`. Fixture:
`tests/fixtures/extensions/runtime-private-secrets/`.

## Rules

| Rule | Behaviour |
| --- | --- |
| Who can call | A background service only. A panel gets `UnsupportedCapability`; a secret never reaches a webview. |
| Scope | Every key belongs to the calling package. The package id comes from the connection, never from the request, and any request field beyond `key` and `value` is `InvalidArguments`, so a package cannot name another package's key. |
| Keys | `^[a-z][a-z0-9-]{0,63}$`. Anything else is `InvalidArguments`. |
| Values | A non-empty string of at most 16384 bytes. Larger is `LimitExceeded`; empty is `InvalidArguments` (use `delete`). |
| Count | 64 keys per package. A 65th key is `LimitExceeded`; overwriting an existing key is always allowed. A refused write changes nothing. |
| Grant | Rechecked natively on every call. Revoke, narrowing, loss of trust, disable, safe mode and a stale version answer `PermissionDenied` before anything is read or written; a write whose grant is revoked while it runs is not applied. |
| Data lifetime | Kept across revoke, disable and update (a re-grant brings it back). Removed when the package is uninstalled, because a secret whose owner is gone could not be revoked from the interface. |
| Storage | `extension-secrets-v1/secrets.json` in the app data directory: a 0600 file written atomically by the same helpers as `src-tauri/src/secret_store.rs`, serialized with its other files. A damaged file answers `HostUnavailable` and is never replaced. |
| Visibility | The webview's read projection (`extensions_private_secrets`, main window only) lists package ids, key names and counts, labelled `kind: "package-owned"`. A value never appears in a projection, a log, an error or a diagnostic. |

## A package secret is not a host credential

PandaCode's own credentials (provider keys, sign-in tokens) live in the host secret store and are never handed to a
package: there is no `credentials.read` permission or call ([ADR-0006](../agent-reference.md#extensions)).
A package that needs one uses `credentials.use`, where the host attaches the credential to the request. The two never
share storage or a key space, so a package secret named like a host credential reads and writes only the package's
own record. This page's secrets are the ones the package owns.

## Errors

`PermissionDenied`, `InvalidArguments`, `LimitExceeded`, `UnsupportedCapability` (a panel, or a method that does not
exist, including `credentials.read`) and `HostUnavailable`.

## How it is checked

- Native: `runtime_private_secrets::tests` (cross-package isolation by direct native calls, limits, revoke, disable,
  untrust, stale version, uninstall, restart persistence, no value in projection or errors, corrupt store).
- Browser preview: `tests/extensions-runtime-private-secrets.spec.ts` in Chromium and WebKit. The preview keeps a
  labelled stand-in store in `localStorage` and answers service calls from a test hook, because it runs no package
  code. Real installed qualification of a service calling `panda.secrets` arrives with the duplex channel (R0201).
