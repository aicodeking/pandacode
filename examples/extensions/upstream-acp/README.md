# Upstream ACP provider (declared launch, experimental API 1)

ZIP **only** `package/extension.json` at the archive root. The package has no code: it declares a harness by
executable and protocol (`contributes.providers[].launch`, runtime slice R0801) and PandaCode speaks ACP to it
exactly as it does to a built-in ACP harness. Composer, trace, queue, history, cancel and the model picker (with
its Speed row from `speedTiers`) are the core's own; the package adds no conversation code.

`__FAKE_AGENT__` stands for `tests/fixtures/extensions/backends/fake-agent.mjs`, the reusable Node fake agent over
the adopted B5 state machine (there is no second protocol implementation). The spec
`tests/upstream-acp-example.spec.ts` replaces it with the real path. To publish a real provider, replace the
command with your CLI's ACP entry point (for example `["gemini", "--acp"]`) and drop `{node}`.

Full walkthrough, what is expressed today and the recorded gaps (G1-G8, each with reproducer, owner and runtime
phase): [docs/extensions/examples/upstream-acp.md](../../../docs/extensions/examples/upstream-acp.md).

No credentials, network, install script or private import. Trusted code runs with the user's OS-account authority;
the package still needs an executable trust decision at install. Real harness smokes are separate and need the
user's explicit authorization; none was run for this example.
