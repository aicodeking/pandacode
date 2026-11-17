// S0608 fixture: the service half of the crash-recovery adapter. It only reports a status line; the quit question
// names it while it says it is working (the one account of src-tauri/src/quit_guard.rs, fed by
// runtime_service_status::quit_packages). Native tests drive the working state through the same B1 `status`
// signal as tests/fixtures/extensions/runtime-service-status/main.cjs; without it this service just idles.
exports.service = async (panda, lifetime) => {
  await lifetime.setStatus({ text: 'Idle', working: false });
};
