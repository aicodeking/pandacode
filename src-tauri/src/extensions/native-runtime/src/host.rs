//! Intended companion. No fixture dispatcher, package loader, broker or native imports.
use pandacode_native_runtime::{read_frame, write_frame, HEAP_BYTES};
use rquickjs::{Context, Runtime};
fn main() {
    let result = (|| -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let request = read_frame(std::io::stdin().lock())?;
        let source = std::str::from_utf8(&request)?;
        let runtime = Runtime::new()?;
        runtime.set_memory_limit(HEAP_BYTES);
        runtime.set_max_stack_size(256 * 1024);
        let start = std::time::Instant::now();
        runtime.set_interrupt_handler(Some(Box::new(move || start.elapsed().as_secs() >= 5)));
        let context = Context::full(&runtime)?;
        let ok = context.with(|ctx| ctx.eval::<rquickjs::Value, _>(source).is_ok());
        Ok(serde_json::to_vec(
            &serde_json::json!({"status":if ok {"Completed"} else {"EngineError"}, "engineMallocBytes":runtime.memory_usage().malloc_size, "heapLimitBytes":HEAP_BYTES}),
        )?)
    })();
    match result {
        Ok(body) => {
            if write_frame(std::io::stdout().lock(), &body).is_err() {
                std::process::exit(2);
            }
        }
        Err(_) => std::process::exit(2),
    }
}
