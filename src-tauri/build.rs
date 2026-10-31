fn main() {
    println!("cargo:rerun-if-changed=build.rs");
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

    panda_onnx();
    link_compiler_rt();
    tauri_build::build()
}

/// `cfg(panda_onnx)`: targets that link Panda Router's ONNX profiler; the same predicate gates `ort` and
/// `tokenizers` in Cargo.toml.
fn panda_onnx() {
    println!("cargo:rustc-check-cfg=cfg(panda_onnx)");
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    if matches!((os.as_str(), arch.as_str()), ("macos", "aarch64") | ("linux", "aarch64") | ("windows", _)) {
        println!("cargo:rustc-cfg=panda_onnx");
    }
}

/// ONNX Runtime's prebuilt CoreML objects call `__isPlatformVersionAtLeast` (`@available`), which
/// lives in clang's compiler-rt; rustc links with `-nodefaultlibs`, so release builds fail without it.
fn link_compiler_rt() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") || std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() != Ok("aarch64") {
        return;
    }
    let Ok(output) = std::process::Command::new("xcrun").args(["clang", "--print-resource-dir"]).output() else {
        return;
    };
    let dir = std::path::PathBuf::from(String::from_utf8_lossy(&output.stdout).trim()).join("lib/darwin");
    if dir.join("libclang_rt.osx.a").is_file() {
        println!("cargo:rustc-link-search=native={}", dir.display());
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
    }
}
