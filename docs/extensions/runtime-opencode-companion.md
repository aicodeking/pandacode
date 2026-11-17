# OpenCode companions

V1 and V2 use different entry points. The native bundle builder prepares a flat,
run-owned module for V1, or package.json/index.js for V2. The same bounded forwarding
core is embedded in each. Inline process configuration preserves existing values and
plugin order: V1 appends a file URL to `plugin`; V2 appends a directory package to
`plugins`. Legacy V1 configuration in a V2 inline document needs normalization first.
No user/project configuration files are read or rewritten.

V1 mutates the executed args object in place and throws an explicit host denial.
Its after callback changes only successful output fields. Return objects have no
approval meaning. V2 registers execute.before/after through Plugin.define/setup,
mutates event.input and completed event.result, and registers permission.evaluate
separately. An explicit deny effect is preserved. Transport errors, deadlines and
disconnects yield no decision. Cleanup aborts pending requests before file removal.

ACP children inherit the inline environment; pure mode refuses companion preparation.
The caller must exclude warm/preloaded processes from reuse across run leases.
The endpoint owner must authenticate the child credential, bind the lease/session,
apply native grants/mode/order rules, and recheck lease validity after dispatch.
Credentials are passed only in the child environment, never plugin files or config.

Source profiles are [V1 v1.19.5](https://github.com/anomalyco/opencode/tree/v1.19.5)
and [V2 c5e741e](https://github.com/anomalyco/opencode/tree/c5e741e787594e8c18fa70ab3a4705db1c927793).
These are source feasibility, not installed qualification. Production has no verified
version/API, so reports UnsupportedCapability without preparing bundles. Real ACP
propagation, SDK package resolution, native callback transport activation and installed
Windows/macOS/Linux behavior remain unqualified. Tests exercise shipped entries against
synthetic loader APIs; the SDK substitution is explicit and does not claim a live load.

Tests written, not run (deferred to the final test phase).
