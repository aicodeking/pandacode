//! Builds without ONNX Runtime (Intel macOS, x86_64 Linux, x86_64 Windows; see `panda_onnx` in build.rs):
//! the profiler never loads, so `Router` stays on the keyword heuristic.

use std::path::Path;

use super::profile::TaskProfile;

pub(super) struct OnnxProfiler;

impl OnnxProfiler {
    pub(super) fn load(_dir: &Path) -> Result<Self, String> {
        Err("This build of PandaCode has no ONNX profiler.".into())
    }

    #[cfg(test)]
    pub(super) fn token_ids(&self, _text: &str) -> Result<Vec<u32>, String> {
        Err("This build of PandaCode has no ONNX profiler.".into())
    }

    pub(super) fn profile_batch(&self, _texts: &[String]) -> Result<Vec<TaskProfile>, String> {
        Err("This build of PandaCode has no ONNX profiler.".into())
    }
}
