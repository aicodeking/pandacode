//! Test-only entry points into the launch: background reaping on.

use super::*;

pub(super) async fn run_process_with_tools(
    config: RunConfig,
    sink: Sink,
    input: UnboundedReceiver<RunInput>,
    command: Command,
    image_blocks: Vec<Value>,
    host: Option<ToolHost>,
) -> Result<(), String> {
    run_process_launch(config, sink, input, command, image_blocks, host, Launch { reap_in_background: true }).await
}

#[cfg(unix)]
pub(super) async fn run_process(
    config: RunConfig,
    sink: Sink,
    input: UnboundedReceiver<RunInput>,
    command: Command,
    image_blocks: Vec<Value>,
) -> Result<(), String> {
    run_process_with_tools(config, sink, input, command, image_blocks, None).await
}
