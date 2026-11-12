//! Fixed, reviewed qualification fixtures only. Not a production extension runner.
use rquickjs::{Context, Runtime};
use serde_json::json;
use std::{
    io::{self, Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

const HEAP_BYTES: usize = 128 * 1024 * 1024;
const RPC_BYTES: usize = 1024 * 1024;
const STACK_BYTES: usize = 256 * 1024;

fn output(value: serde_json::Value) {
    println!("{value}");
    io::stdout().flush().unwrap();
}

fn evaluate(case: &str, deadline: Duration, announce: bool) {
    let source = match case {
        "loop" | "cancel" => {
            include_str!("../../../../../tests/fixtures/extensions/runtime/loop.js")
        }
        "allocation" => {
            include_str!("../../../../../tests/fixtures/extensions/runtime/allocation.js")
        }
        "exception" => {
            include_str!("../../../../../tests/fixtures/extensions/runtime/exception.js")
        }
        "denials" => include_str!("../../../../../tests/fixtures/extensions/runtime/denials.js"),
        _ => panic!("unknown fixed fixture"),
    };
    let runtime = Runtime::new().unwrap();
    runtime.set_memory_limit(HEAP_BYTES);
    runtime.set_max_stack_size(STACK_BYTES);
    let cancelled = Arc::new(AtomicBool::new(false));
    if case == "cancel" {
        let flag = cancelled.clone();
        // This test-owned process exits after one evaluation; EOF is cancellation too.
        std::thread::spawn(move || {
            let _ = io::stdin().read_exact(&mut [0]);
            flag.store(true, Ordering::SeqCst);
        });
    }
    let interrupted = Arc::new(AtomicBool::new(false));
    let timed_out = interrupted.clone();
    let cancel = cancelled.clone();
    // For looping fixtures, acknowledge from inside the interpreter's first interrupt
    // callback. The parent must prove overlap/cancel during execution, not just startup.
    let execution_ready = announce && matches!(case, "loop" | "cancel");
    let ready_case = case.to_owned();
    let mut announced = !execution_ready;
    let start = Instant::now();
    runtime.set_interrupt_handler(Some(Box::new(move || {
        if !announced {
            output(json!({"ready":ready_case}));
            announced = true;
        }
        if cancel.load(Ordering::SeqCst) {
            return true;
        }
        if start.elapsed() >= deadline {
            timed_out.store(true, Ordering::SeqCst);
            return true;
        }
        false
    })));
    let context = Context::full(&runtime).unwrap();
    if announce && !execution_ready {
        output(json!({"ready":case}));
    }
    let (ok, error) = context.with(|ctx| {
        match ctx.eval::<rquickjs::Value, _>(source).and_then(|value| {
            if let Some(promise) = value.as_promise() {
                promise.finish::<()>()?;
            }
            Ok(())
        }) {
            Ok(()) => (true, None),
            Err(_) => (
                false,
                ctx.catch().as_exception().and_then(|error| error.message()),
            ),
        }
    });
    let usage = runtime.memory_usage();
    let status = if cancelled.load(Ordering::SeqCst) {
        "Cancelled"
    } else if interrupted.load(Ordering::SeqCst) {
        "Timeout"
    } else if ok {
        "Completed"
    } else {
        "EngineError"
    };
    output(
        json!({"case":case, "status":status, "elapsedMs":start.elapsed().as_millis(),
        "heapLimitBytes":HEAP_BYTES, "engineMallocBytes":usage.malloc_size,
        "stackLimitBytes":STACK_BYTES, "processMemoryLimitEnforced":false,
        "osSandboxEnforced":false, "fixtureError":error}),
    );
}

fn rpc() {
    // A qualification-only channel bound to this test principal. Never trust a JS owner field.
    output(json!({"ready":"rpc"}));
    let mut header = [0; 4];
    let status = if io::stdin().read_exact(&mut header).is_err() {
        "InvalidFrame"
    } else {
        let size = u32::from_le_bytes(header) as usize;
        if size > RPC_BYTES {
            "LimitExceeded"
        } else {
            let mut bytes = vec![0; size];
            if io::stdin().read_exact(&mut bytes).is_err() {
                "InvalidFrame"
            } else {
                match serde_json::from_slice::<serde_json::Value>(&bytes) {
                    Ok(value)
                        if value.as_object().is_some_and(|object| {
                            object.len() == 1
                                && object.get("operation").is_some_and(|v| v == "ping")
                        }) =>
                    {
                        "Completed"
                    }
                    _ => "PermissionDenied",
                }
            }
        }
    };
    output(
        json!({"case":"rpc", "status":status, "rpcLimitBytes":RPC_BYTES,
        "principal":"qualification.fixture", "osSandboxEnforced":false}),
    );
}

fn main() {
    let case = std::env::args()
        .nth(1)
        .expect("fixed fixture name required");
    match case.as_str() {
        "rpc" => rpc(),
        "continuity" => {
            evaluate("loop", Duration::from_secs(5), true);
            evaluate("allocation", Duration::from_secs(5), false);
            evaluate("exception", Duration::from_secs(5), false);
        }
        "loop" | "allocation" | "exception" | "denials" | "cancel" => {
            evaluate(&case, Duration::from_secs(5), true)
        }
        _ => panic!("unknown fixed fixture"),
    }
}
