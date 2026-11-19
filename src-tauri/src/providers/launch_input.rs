//! Run input that arrives while a launch has no process yet (it is waiting for the previous
//! process of its session to exit).

use super::RunInput;
use std::collections::VecDeque;
use tokio::sync::mpsc::UnboundedReceiver;

/// Resolves only when the run is asked to stop (`RunInput::Stop`). Anything else sent before the
/// process exists (steers, controls) is kept in `early`, in order, for the run loop to take
/// first. A closed input never resolves: the launch keeps waiting for the exit and still runs.
pub(super) async fn stop_requested(input: &mut UnboundedReceiver<RunInput>, early: &mut VecDeque<RunInput>) {
    while let Some(action) = input.recv().await {
        if matches!(action, RunInput::Stop) {
            return;
        }
        early.push_back(action);
    }
    std::future::pending::<()>().await;
}

/// The next run input: those held from before the process started, then new ones.
pub(super) async fn next_input(early: &mut VecDeque<RunInput>, input: &mut UnboundedReceiver<RunInput>) -> Option<RunInput> {
    match early.pop_front() {
        Some(action) => Some(action),
        None => input.recv().await,
    }
}
