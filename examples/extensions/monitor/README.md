# Machine monitor (`sample.monitor`)

A trusted background service that reads a metrics daemon and shows a status item, a table and a rich panel with cards,
sparklines and 30-minute charts, with attributed notices by rule. The guide, with the contracts it uses and its limits, is
[docs/extensions/examples/monitor.md](../../../docs/extensions/examples/monitor.md).

- `package/`: the installable package (`extension.json`, `main.cjs`, `lib/monitor.mjs`, `panel/`).
- Tests (written, not run): `tests/extensions-example-monitor.spec.ts`; fixtures: `tests/fixtures/extensions/example-monitor/`.
