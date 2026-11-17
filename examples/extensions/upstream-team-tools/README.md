# Upstream team tools (experimental API 1)

A package that declares a tool and a team-capable provider that delivers the tool to its team role, with the package name on
every row it emits. ZIP only `package/extension.json` and `package/main.cjs`, install, review executable trust, enable and
allow `tools.execute`. Select **Team tools worker** as a team worker; the lead's catalog reaches it through
`run.teamTools`, and the tool row `sample.upstream-team-tools/lookup` is shown in the trace.

Today the tool reaches only this package's own provider. Offering a package tool to the built-in harnesses' team agents is
the model-tool slice (R7, `tools.model`); the gap is recorded in
[docs/extensions/examples/upstream-api-tools.md](../../../docs/extensions/examples/upstream-api-tools.md). No network,
credential or external command is used.
