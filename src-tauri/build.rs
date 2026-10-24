fn main() {
    // The native dialog stack imports `comctl32!TaskDialogIndirect`, which only
    // the version 6 common controls export. tauri-build embeds that manifest in
    // the app binary, but test binaries link no resource file and would bind the
    // System32 copy (5.82) at load time, so they never start
    // (`STATUS_ENTRYPOINT_NOT_FOUND`). Delay-loading the library keeps the import
    // out of the loader's startup work; the app, which does have the manifest,
    // still resolves version 6 on the first call.
    #[cfg(windows)]
    {
        println!("cargo:rustc-link-arg=/DELAYLOAD:comctl32.dll");
        println!("cargo:rustc-link-arg=delayimp.lib");
    }

    tauri_build::build()
}
