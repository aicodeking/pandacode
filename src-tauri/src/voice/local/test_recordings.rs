//! Settings test recordings: the mic test (a WAV played back, never transcribed) and the model
//! test (transcribed with one model). A model test owns its model from Start until its
//! transcription ends, so that model cannot be deleted meanwhile; Cancel also stops a running
//! transcription, including one still waiting for the engine.
use super::{authorized, capture, Local, Voice};
use crate::Result;
use serde::Serialize;
use std::{
    future::Future,
    sync::{Arc, MutexGuard, Mutex},
    time::Duration,
};
use tokio::sync::watch;

const MIC_TEST_CAP: Duration = Duration::from_secs(10);
const MODEL_TEST_CAP: Duration = Duration::from_secs(30);
/// Event carrying the mic test's live input level; see the IPC contract in `local/mod.rs`.
pub(super) const MIC_TEST_LEVEL: &str = "voice://mic-test-level";
const NOT_RUNNING: &str = "No test recording is running.";
/// `voice_local_delete` while the model test records, converts or transcribes with that model.
pub(super) const TEST_HOLDS: &str = "Stop the model test first.";
/// A dictation or other test Start while a test recording holds the microphone.
const MIC_TEST_RECORDING: &str = "Finish the microphone test first.";
const MODEL_TEST_RECORDING: &str = "Finish the model test first.";

/// Which test a probe command drives.
pub(super) type Which = fn(&Local) -> &TestSlot;

/// A mic or model test recording, or the Start still waiting for permission or the device.
#[derive(Default)]
pub(super) struct TestSlot(Mutex<TestState>);
#[derive(Default)]
struct TestState {
    probe: Option<capture::Probe>,
    /// The model a model test transcribes with (`None`: the selection read at Stop).
    model: Option<String>,
    /// Generation of the Start in progress; a Stop, Cancel or newer Start clears it.
    pending: Option<u64>,
    generation: u64,
    /// A stopped model test converting or transcribing its recording.
    running: Option<Running>,
}
struct Running {
    generation: u64,
    model: Option<String>,
    cancel: watch::Sender<bool>,
}
/// What a Stop or Cancel found: the recording, a pending Start (now cancelled), or nothing.
pub(super) enum Taken { Probe(capture::Probe), Pending, Idle }

impl TestSlot {
    fn lock(&self) -> Result<MutexGuard<'_, TestState>> {
        self.0.lock().map_err(|_| super::UNAVAILABLE.to_owned())
    }
    /// Claims the slot for a Start (superseding a pending one); returns its generation and any
    /// recording it replaces.
    fn begin(&self, model: Option<String>) -> Result<(u64, Option<capture::Probe>)> {
        let mut state = self.lock()?;
        state.generation += 1;
        state.pending = Some(state.generation);
        state.model = model;
        Ok((state.generation, state.probe.take()))
    }
    fn is_pending(&self, generation: u64) -> bool {
        self.lock().is_ok_and(|s| s.pending == Some(generation))
    }
    /// Gives up a failed Start's claim.
    fn release(&self, generation: u64) {
        let _ = self.lock().map(|mut s| s.pending = s.pending.filter(|p| *p != generation));
    }
    /// Keeps the Start's recording, or hands it back when the Start was cancelled meanwhile.
    fn install(&self, generation: u64, probe: capture::Probe) -> std::result::Result<(), capture::Probe> {
        match self.lock() {
            Ok(mut state) if state.pending == Some(generation) => {
                state.pending = None;
                state.probe = Some(probe);
                Ok(())
            }
            _ => Err(probe),
        }
    }
    /// For Stop and Cancel: the recording, or the pending Start (cancelled by this call). Also
    /// cancels a running model test transcription.
    pub(super) fn take(&self) -> Result<Taken> {
        let mut state = self.lock()?;
        if let Some(running) = &state.running {
            let _ = running.cancel.send(true);
        }
        if let Some(probe) = state.probe.take() {
            state.model = None;
            return Ok(Taken::Probe(probe));
        }
        state.model = None;
        Ok(if state.pending.take().is_some() { Taken::Pending } else { Taken::Idle })
    }
    /// A model test Stop: takes the recording and marks it running (still owning its model)
    /// until the returned guard drops.
    fn take_to_run(slot: Which, local: &Arc<Local>) -> Result<Option<(capture::Probe, Option<String>, RunGuard)>> {
        let mut state = slot(local).lock()?;
        let Some(probe) = state.probe.take() else {
            // No recording: cancel a pending Start, but leave a running transcription alone.
            if state.pending.take().is_some() {
                state.model = None;
                return Ok(None);
            }
            return Err(NOT_RUNNING.into());
        };
        let model = state.model.take();
        state.generation += 1;
        let (cancel, cancelled) = watch::channel(false);
        state.running = Some(Running { generation: state.generation, model: model.clone(), cancel });
        let guard = RunGuard { local: local.clone(), slot, generation: state.generation, cancelled };
        Ok(Some((probe, model, guard)))
    }
    /// True while this test records (or starts, or transcribes) with `model_id`; a test without
    /// its own model uses `selected`.
    pub(super) fn holds(&self, model_id: &str, selected: Option<&str>) -> bool {
        let Ok(state) = self.lock() else { return true };
        let uses = |model: &Option<String>| model.as_deref().or(selected) == Some(model_id);
        ((state.probe.is_some() || state.pending.is_some()) && uses(&state.model))
            || state.running.as_ref().is_some_and(|r| uses(&r.model))
    }
    /// True while this test records or its Start waits for permission or the device; a
    /// poisoned slot counts as recording, so a dictation refuses rather than share the mic.
    fn records(&self) -> bool {
        self.lock().map_or(true, |s| s.probe.is_some() || s.pending.is_some())
    }
    #[cfg(test)]
    pub(super) fn is_idle(&self) -> bool {
        self.lock().is_ok_and(|s| s.probe.is_none() && s.pending.is_none() && s.running.is_none())
    }
}

/// Ends a running model test (its model may be deleted again) when dropped.
struct RunGuard {
    local: Arc<Local>,
    slot: Which,
    generation: u64,
    cancelled: watch::Receiver<bool>,
}
impl Drop for RunGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = (self.slot)(&self.local).lock() {
            if state.running.as_ref().is_some_and(|r| r.generation == self.generation) {
                state.running = None;
            }
        }
    }
}

#[derive(Default, Serialize)]
pub struct TestText {
    text: String,
    /// A Stop that cancelled a Start still waiting for permission or the device, or whose
    /// transcription was cancelled.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    cancelled: bool,
}
impl TestText {
    fn cancelled() -> Self {
        Self { cancelled: true, ..Self::default() }
    }
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicTest {
    wav_base64: String,
    duration_ms: u64,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    cancelled: bool,
}

/// Event telling the webview that a test recording ended without its Stop; see the IPC contract
/// in `local/mod.rs`.
pub(in crate::voice) const TEST_ENDED: &str = "voice://test-ended";

/// Which test recording `voice://test-ended` is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(in crate::voice) enum TestKind {
    Mic,
    Model,
}

/// `voice://test-ended` payload: `{ kind: 'mic' | 'model', reason: 'closed' }`.
#[derive(Clone, Debug, Serialize)]
pub(in crate::voice) struct TestEnded {
    kind: TestKind,
    reason: &'static str,
}
impl TestEnded {
    pub(in crate::voice) fn closed(kind: TestKind) -> Self {
        Self { kind, reason: "closed" }
    }
}

impl Local {
    /// Why a dictation cannot start now: a test recording (or its Start) holds the microphone.
    pub(in crate::voice) fn test_recording(&self) -> Option<&'static str> {
        [(&self.mic_test, MIC_TEST_RECORDING), (&self.model_test, MODEL_TEST_RECORDING)]
            .into_iter()
            .find_map(|(slot, message)| slot.records().then_some(message))
    }

    /// Why the test `which` cannot start now: the other test records (or starts).
    fn other_test_recording(&self, which: Which) -> Option<&'static str> {
        let (other, message) = if std::ptr::eq(which(self), &self.mic_test) {
            (&self.model_test, MODEL_TEST_RECORDING)
        } else {
            (&self.mic_test, MIC_TEST_RECORDING)
        };
        other.records().then_some(message)
    }

    /// Closes both test recordings and cancels a running model test (window hidden or exit).
    /// Returns the kinds whose recording it discarded (not pending Starts or transcriptions).
    pub(in crate::voice) fn stop_tests(&self) -> Vec<TestKind> {
        [(&self.model_test, TestKind::Model), (&self.mic_test, TestKind::Mic)]
            .into_iter()
            .filter_map(|(slot, kind)| match slot.take() {
                Ok(Taken::Probe(probe)) => {
                    let _ = probe.finish();
                    Some(kind)
                }
                _ => None,
            })
            .collect()
    }
}

impl Voice {
    async fn start_probe(&self, which: Which, cap: Duration, model: Option<String>, meter: capture::Meter) -> Result<()> {
        let device = self.preferences().ok().and_then(|p| p.device_name);
        let permission = async {
            tokio::time::timeout(Duration::from_secs(120), super::super::permission::request())
                .await
                .map_err(|_| "Microphone permission request timed out. Try again.".to_owned())?
        };
        self.start_probe_with(which, permission, model, move || capture::Probe::start(device, cap, meter)).await
    }

    /// Start of a test recording: waits for `permission`, then `open`s the device. A Stop,
    /// Cancel or newer Start meanwhile cancels it: it never opens, or closes what it opened.
    pub(super) async fn start_probe_with(
        &self,
        which: Which,
        permission: impl Future<Output = Result<()>>,
        model: Option<String>,
        open: impl FnOnce() -> Result<capture::Probe> + Send + 'static,
    ) -> Result<()> {
        if self.session_active() {
            return Err(super::super::ACTIVE.into());
        }
        // The two tests share the microphone too: each refuses while the other records.
        if let Some(busy) = self.local.other_test_recording(which) {
            return Err(busy.into());
        }
        let (generation, replaced) = which(&self.local).begin(model)?;
        if let Some(old) = replaced {
            crate::blocking(move || old.finish().map(|_| ())).await.ok();
        }
        // A dictation reserving meanwhile either saw this Start pending (and refused) or is seen
        // here; likewise the other test's Start (both may refuse, never both record).
        if self.session_active() {
            which(&self.local).release(generation);
            return Err(super::super::ACTIVE.into());
        }
        if let Some(busy) = self.local.other_test_recording(which) {
            which(&self.local).release(generation);
            return Err(busy.into());
        }
        if let Err(error) = permission.await {
            which(&self.local).release(generation);
            return Err(error);
        }
        let local = self.local.clone();
        crate::blocking(move || {
            let slot = which(&local);
            if !slot.is_pending(generation) {
                return Err(super::super::CANCELLED.into());
            }
            let probe = open().inspect_err(|_| slot.release(generation))?;
            slot.install(generation, probe).map_err(|probe| {
                let _ = probe.finish();
                super::super::CANCELLED.to_owned()
            })
        })
        .await
    }

    /// Stop or Cancel without a result: discards the recording, cancels a pending Start, and
    /// cancels a running model test transcription.
    pub(super) async fn cancel_probe(&self, which: Which) -> Result<()> {
        let local = self.local.clone();
        crate::blocking(move || {
            if let Taken::Probe(probe) = which(&local).take()? {
                let _ = probe.finish();
            }
            Ok(())
        })
        .await
    }

    /// `voice_local_test_model` stop: transcribes the test, or cancels a pending Start. A
    /// cancelled transcription resolves `{ cancelled: true }`.
    pub(super) async fn model_test_stop(&self) -> Result<TestText> {
        let local = self.local.clone();
        let taken = crate::blocking(move || {
            let Some((probe, model, guard)) = TestSlot::take_to_run(|l| &l.model_test, &local)? else {
                return Ok(None);
            };
            let pcm = probe.finish()?.mono_f32_16k()?;
            Ok(Some((pcm, model, guard)))
        })
        .await?;
        let Some((pcm, model, guard)) = taken else {
            return Ok(TestText::cancelled());
        };
        if *guard.cancelled.borrow() {
            return Ok(TestText::cancelled());
        }
        let route = self.local.test_route(&self.preferences()?, model.as_deref())?;
        match self.local.run(route, pcm, guard.cancelled.clone()).await {
            Ok(text) => Ok(TestText { text, cancelled: false }),
            Err(_) if *guard.cancelled.borrow() => Ok(TestText::cancelled()),
            Err(error) => Err(error),
        }
    }

    /// `voice_mic_test_stop`: the recording as a WAV, or cancels a pending Start.
    pub(super) async fn mic_test_stop(&self) -> Result<MicTest> {
        let local = self.local.clone();
        crate::blocking(move || {
            use base64::Engine as _;
            let pcm = match local.mic_test.take()? {
                Taken::Probe(probe) => probe.finish()?,
                Taken::Pending => return Ok(MicTest { cancelled: true, ..MicTest::default() }),
                Taken::Idle => return Err(NOT_RUNNING.into()),
            };
            Ok(MicTest {
                duration_ms: pcm.duration_ms(),
                wav_base64: base64::engine::general_purpose::STANDARD.encode(pcm.wav()?),
                cancelled: false,
            })
        })
        .await
    }
}

#[tauri::command]
pub async fn voice_local_test_model(
    window: tauri::WebviewWindow,
    voice: tauri::State<'_, Voice>,
    action: String,
    model_id: Option<String>,
) -> Result<TestText> {
    authorized(&window)?;
    let voice = voice.inner().clone();
    match action.as_str() {
        "start" => {
            let prefs = voice.preferences()?;
            voice.local.test_route(&prefs, model_id.as_deref())?;
            voice.start_probe(|l| &l.model_test, MODEL_TEST_CAP, model_id, Box::new(|_| ())).await?;
            Ok(TestText::default())
        }
        "stop" => voice.model_test_stop().await,
        "cancel" => {
            voice.cancel_probe(|l| &l.model_test).await?;
            Ok(TestText::default())
        }
        _ => Err("Unknown model test action.".into()),
    }
}

#[tauri::command]
pub async fn voice_mic_devices(window: tauri::WebviewWindow) -> Result<Vec<capture::MicDevice>> {
    authorized(&window)?;
    crate::blocking(|| Ok(capture::devices())).await
}

#[tauri::command]
pub async fn voice_mic_test_start(window: tauri::WebviewWindow, voice: tauri::State<'_, Voice>) -> Result<()> {
    authorized(&window)?;
    voice.inner().clone().start_probe(|l| &l.mic_test, MIC_TEST_CAP, None, mic_test_meter(tauri::Manager::app_handle(&window).clone())).await
}

/// `voice://mic-test-level` payload: the mic test's live input level.
#[derive(Clone, Serialize)]
struct MicTestLevel {
    level: f32,
}

/// Emits `voice://mic-test-level` `{ level }` (0..1, 10 Hz) to the main window while the mic test records.
fn mic_test_meter(app: tauri::AppHandle) -> capture::Meter {
    use tauri::{Emitter, Manager};
    Box::new(move |level| {
        if let Some(window) = app.get_webview_window("main") {
            let level = if level.is_finite() { level.clamp(0.0, 1.0) } else { 0.0 };
            let _ = window.emit(MIC_TEST_LEVEL, MicTestLevel { level });
        }
    })
}

#[tauri::command]
pub async fn voice_mic_test_stop(window: tauri::WebviewWindow, voice: tauri::State<'_, Voice>) -> Result<MicTest> {
    authorized(&window)?;
    voice.inner().clone().mic_test_stop().await
}

#[tauri::command]
pub async fn voice_mic_test_cancel(window: tauri::WebviewWindow, voice: tauri::State<'_, Voice>) -> Result<()> {
    authorized(&window)?;
    voice.inner().clone().cancel_probe(|l| &l.mic_test).await
}
