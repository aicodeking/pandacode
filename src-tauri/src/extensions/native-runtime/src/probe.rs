//! Test-only native escape-surrogate: run through the proposed reusable launch boundary.
use pandacode_native_runtime::{read_frame, write_frame};
use serde_json::json;
fn main() {
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some("--sid") {
        println!("{}", pandacode_native_runtime::container_sid().unwrap());
        return;
    }
    let request = read_frame(std::io::stdin().lock()).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&request).unwrap();
    let body = match value["case"].as_str().unwrap() {
        "denials" => {
            let path = value["canary"].as_str().unwrap();
            let address = value["listener"].as_str().unwrap().parse().unwrap();
            let fs = std::fs::read(path).is_err();
            let write = std::fs::OpenOptions::new().write(true).open(path).is_err();
            let network = std::net::TcpStream::connect_timeout(
                &address,
                std::time::Duration::from_millis(500),
            )
            .is_err();
            let process = std::process::Command::new(std::env::current_exe().unwrap())
                .spawn()
                .is_err();
            json!({"filesystemDenied":fs,"writeDenied":write,"loopbackDenied":network,"processDenied":process,"environmentEmpty":std::env::vars_os().next().is_none()})
        }
        "loop" => loop {
            std::hint::spin_loop();
        },
        "crash" => std::process::abort(),
        "oversized" => {
            use std::io::Write;
            std::io::stdout()
                .write_all(&(1024u32 * 1024 + 1).to_le_bytes())
                .unwrap();
            return;
        }
        "allocation" => {
            #[cfg(windows)]
            unsafe {
                use windows::Win32::System::Memory::*;
                let mut allocations = Vec::new();
                loop {
                    let block =
                        VirtualAlloc(None, 1024 * 1024, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
                    if block.is_null() {
                        break;
                    }
                    std::ptr::write_bytes(block, 0x5a, 1024 * 1024);
                    allocations.push(block);
                }
                let result =
                    json!({"nativeAllocatedBytes":allocations.len()*1024*1024,"commitDenied":true});
                for block in allocations {
                    VirtualFree(block, 0, MEM_RELEASE).unwrap();
                }
                result
            }
            #[cfg(not(windows))]
            {
                panic!("Windows qualification required")
            }
        }
        _ => json!({"independent":true}),
    };
    write_frame(
        std::io::stdout().lock(),
        &serde_json::to_vec(&body).unwrap(),
    )
    .unwrap();
}
