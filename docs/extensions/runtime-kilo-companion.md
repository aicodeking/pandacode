# Kilo companion

Kilo has an independent source profile at
`37b2900fcb6223fec33c2bd5f59263e93682c670`, API `kilo.plugin.v1`.
OpenCode qualification never qualifies Kilo. Unknown versions/APIs and pure mode
return `UnsupportedCapability`. No installed Kilo version is currently qualified.

The native builder materializes the shared V1 module under the R0601 run lease.
Only `KILO_CONFIG_CONTENT` with singular `plugin` is injected into the child
environment; existing values/order survive. Plural `plugins`, directory packages
and V2 setup entries are refused. No global or project configuration is written.
The transport and cleanup implementation is shared with the OpenCode V1 adapter.
Credentials are child environment only; a native authenticated endpoint must
recheck the current lease, package trust, scope and grants for every callback.

Before callbacks mutate the existing args object; explicit denial throws outside
the forwarding error handler. After callbacks mutate title/output/metadata on
successful results. Callback return values do not approve tools. Errors, deadlines
and disconnected transports make no decision. Kilo's sandbox and goal policies
remain authoritative; this adapter adds no bypass or model/compaction power.

| Evidence | Status |
| --- | --- |
| Pinned source API/config | Source feasible |
| Synthetic loader, original args, denial, result mutation, disposal | Tests written, not run |
| Real ACP environment inheritance and installed Kilo | Unqualified; requires authorization |
| Native endpoint activation, provider launch/warm exclusion | Integration pending; profile disabled in production |
| Windows/macOS/Linux installed runtime | Unqualified |

Source: [Kilo config compatibility](https://github.com/Kilo-Org/kilocode/blob/37b2900fcb6223fec33c2bd5f59263e93682c670/packages/opencode/src/config/v2-compat.ts),
[tool execution](https://github.com/Kilo-Org/kilocode/blob/37b2900fcb6223fec33c2bd5f59263e93682c670/packages/opencode/src/session/tools.ts).
The canonical ACP backend remains `tests/fixtures/extensions/backends/`;
the loader fixture is not a second ACP implementation or an executed handshake.
