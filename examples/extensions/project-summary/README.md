# SDK project summary (experimental API 1, TypeScript SDK)

An executable package written in TypeScript against the public `@pandacode/extensions` types. The
**SDK summary** header button registers its declared command, queries the captured project summary
and stages a dialog with the result. Full walkthrough: [development](../../../docs/extensions/development.md).

```sh
npx tsc -p examples/extensions/project-summary/tsconfig.json
node --test tests/extensions-examples.test.mjs
```

```powershell
Compress-Archive -Path examples/extensions/project-summary/package/* -DestinationPath $env:TEMP/sample.sdk-summary.zip -Force
```

Install, accept executable trust, enable, then allow project-summary access for the package; with
no API consent the query is rejected even though the code is trusted. For iteration, select the
`package/` folder under Settings → Extensions → Trusted extension development and use **Reload**.
