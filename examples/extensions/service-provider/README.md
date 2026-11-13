# Public service provider (experimental API 1)

Create a ZIP with `package/extension.json` and `package/main.cjs` at the archive root (not inside a `package/` folder), install it through Settings → Extensions → Install local package, review executable trust and enable it before installing the consumer. No account, download or network is used. The manifest explicitly exports `greeting` version `1.0.0`, with string request/result/event schemas. `privateMethod` is not public.

Calls use a fresh supervised provider process (five-second deadline), not a persistent shared JS object. The provider receives the broker-authenticated consumer and captured project context. It does not receive raw host handles. API scope is not OS confinement of trusted executable code.
