# Codex command companion

The native adapter and its preview twin implement the source-profile sequence: declare
`features.hooks` and the exact event keys in the process session layer, initialize,
request `hooks/list` for the run cwd, then load the intended thread with targeted
`hooks.state`. Only unique session-flag command entries matching the host command
are trusted, using the inventory's exact key and currentHash. Inventory is consumed
once; resume starts with no cached state. Errors, ambiguity and expired leases
prevent injection. Existing model/MCP configuration is preserved.

PreToolUse supports deny and input rewrite; it never approves a permission request.
PermissionRequest supports actual allow/deny and cannot rewrite inputs. PostToolUse
does not replace output in this profile. The host must apply native grants, mode
restrictions, ordering and deny precedence before translating a decision.

The bundled Node forwarder has bounded stdin/reply size and deadlines, accepts only
the host loopback endpoint, and writes only hook JSON to stdout. A run credential
belongs in the child environment, never the command or declarations. Missing host,
timeout or malformed response produces an empty decision and ordinary approvals.
Host command rendering admits the pinned default cmd /C dialect and POSIX quoting;
custom shells and unsupported Windows path characters need another profile.

Qualification: source feasible only, pinned to
[Codex aea4c6e](https://github.com/openai/codex/tree/aea4c6ee4b652d84b416731b11c2b8299d767209/codex-rs/hooks).
The state machine and forwarder are shipped adapter components, not evidence of an
installed CLI run. No installed version, authenticated callback endpoint or provider
bootstrap integration has been qualified. Production discovery supplies no version/API
and reports UnsupportedCapability before construction. No real CLI or configuration
is inspected. Completing activation requires wiring an authenticated transport and the
declaration/inventory phases into the owning app-server lifecycle, excluding warm or
preloaded processes with a different lease. The fixture is synthetic, not a live capture.

Tests written, not run (deferred to the final test phase).
