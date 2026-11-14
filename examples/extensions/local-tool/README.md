# Local tool (experimental API 1, TypeScript SDK)

An executable package written in TypeScript against the public `@pandacode/extensions` types. The
**Count words** button runs the manifest-declared tool `sample.local-tool/count` as an owned job in
the captured project folder and shows its state in a staged dialog. The tool receives only literal
arguments: no shell, executable path, PID, cwd input, network or download.

Build and validate from the repository root:

```sh
npx tsc -p examples/extensions/local-tool/tsconfig.json
node --test tests/extensions-examples.test.mjs
```

Zip only `package/` (`extension.json` and the generated `main.cjs`):

```powershell
Compress-Archive -Path examples/extensions/local-tool/package/* -DestinationPath $env:TEMP/sample.local-tool.zip -Force
```

Install it, accept the executable trust review for this content and enable it. The first run is
refused until you allow tool execution for the package (`PermissionDenied`); revoking cancels a
running job. Bounds: 32 progress messages of 512 bytes, one 8192-byte result, the declared
`timeoutMs` (at most 30 s). Trusted code has normal user OS authority; the API grant is not a
sandbox. See [runtime](../../../docs/extensions/runtime.md) and [development](../../../docs/extensions/development.md).
