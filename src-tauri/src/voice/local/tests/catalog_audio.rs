use super::*;

// ---- catalog and language ----

#[test]
fn bundled_catalog_parses_and_every_entry_is_valid() {
    let raw: serde_json::Value = serde_json::from_str(catalog::BUNDLED).unwrap();
    let parsed = Catalog::bundled();
    assert_eq!(parsed.models.len(), raw["models"].as_array().unwrap().len());
    assert!(parsed.vad.is_some());
    assert!(parsed.default_model.as_deref().is_some_and(|id| parsed.model(id).is_some()));
    assert!(parsed.model("handy-computer/moonshine-tiny-gguf").is_some());
}

#[test]
fn catalog_rejects_invalid_entries() {
    let mut bad_sha = model_json("test/sha", "sha.gguf", &["en"], false);
    bad_sha["sha256"] = "XYZ".into();
    let mut zero = model_json("test/zero", "zero.gguf", &["en"], false);
    zero["size"] = 0.into();
    let mut no_lang = model_json("test/nolang", "nolang.gguf", &[], false);
    no_lang["name"] = "ok".into();
    let json = catalog_json(vec![
        model_json("test/one", "one.gguf", &["en"], false),
        model_json("test/one", "dup-id.gguf", &["en"], false),
        model_json("test/two", "one.gguf", &["en"], false),
        model_json("test/path", "../escape.gguf", &["en"], false),
        model_json("bad id", "x.gguf", &["en"], false),
        model_json("test/part", "x.gguf.part", &["en"], false),
        model_json("test/vadfile", "vad.gguf", &["en"], false),
        bad_sha,
        zero,
        no_lang,
        serde_json::json!({"id": "test/garbage"}),
    ]);
    let parsed = Catalog::parse(&json).unwrap();
    let ids: Vec<_> = parsed.models.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, vec!["test/one"]);
    assert_eq!(parsed.default_model.as_deref(), Some("test/one"));
    assert!(Catalog::parse("{").is_err());
}

#[test]
fn language_rules_follow_model_capabilities() {
    // Single-language models always use their language.
    assert_eq!(catalog::run_language(&model(&["ru"], false), "auto").as_deref(), Some("ru"));
    assert_eq!(catalog::run_language(&model(&["ru"], false), "en").as_deref(), Some("ru"));
    // A fixed language uses the model's own spelling.
    let multi = model(&["en", "pt-BR", "zh"], true);
    assert_eq!(catalog::run_language(&multi, "PT-br").as_deref(), Some("pt-BR"));
    assert_eq!(catalog::run_language(&multi, "pt").as_deref(), Some("pt-BR"));
    assert_eq!(catalog::run_language(&multi, "zh-Hans").as_deref(), Some("zh"));
    // Auto: detection → nothing; else English; else the first language.
    assert_eq!(catalog::run_language(&multi, "auto"), None);
    assert_eq!(catalog::run_language(&model(&["de", "en"], false), "auto").as_deref(), Some("en"));
    assert_eq!(catalog::run_language(&model(&["de", "fr"], false), "auto").as_deref(), Some("de"));
    // An unsupported fixed choice falls back to the Auto rule.
    assert_eq!(catalog::run_language(&model(&["de", "fr"], false), "ja").as_deref(), Some("de"));
}

#[test]
fn chunk_size_comes_from_the_catalog() {
    let mut m = model(&["en"], false);
    assert_eq!(m.chunk_samples(), Some(40_000 * 16));
    m.max_audio_ms = Some(30_000);
    assert_eq!(m.chunk_samples(), Some(15_000 * 16));
    m.supports_long_form = Some(true);
    assert_eq!(m.chunk_samples(), None);
}

// ---- chunking ----

#[test]
fn chunking_splits_fixed_chunks_and_halves_rejected_ones() {
    let pcm = vec![0.0f32; 50_000];
    let mut sizes = Vec::new();
    let text = audio::transcribe_chunked(&pcm, Some(20_000), &mut |c| {
        sizes.push(c.len());
        Ok(format!("{}", c.len()))
    })
    .unwrap();
    assert_eq!(sizes, vec![20_000, 20_000, 10_000]);
    assert_eq!(text, "20000 20000 10000");

    // Anything over 10k samples is "too long": halves until it fits.
    let mut sizes = Vec::new();
    let text = audio::transcribe_chunked(&pcm[..40_000], None, &mut |c| {
        sizes.push(c.len());
        if c.len() > 10_000 { Err(RunError::Split { partial: String::new() }) } else { Ok("x".into()) }
    })
    .unwrap();
    assert_eq!(sizes, vec![40_000, 20_000, 10_000, 10_000, 20_000, 10_000, 10_000]);
    assert_eq!(text, "x x x x");
}

#[test]
fn chunking_stops_halving_at_the_minimum_and_keeps_partial_text() {
    let pcm = vec![0.0f32; 7_000];
    let mut calls = 0;
    let text = audio::transcribe_chunked(&pcm, None, &mut |_| {
        calls += 1;
        Err(RunError::Split { partial: "partial".into() })
    })
    .unwrap();
    assert_eq!((calls, text.as_str()), (1, "partial"));
    let error = audio::transcribe_chunked(&pcm, None, &mut |_| Err(RunError::Split { partial: " ".into() }));
    assert!(error.is_err());
    let fatal = audio::transcribe_chunked(&pcm, None, &mut |_| Err(RunError::Fatal("boom".into())));
    assert_eq!(fatal.unwrap_err(), "boom");
    assert_eq!(audio::transcribe_chunked(&[], None, &mut |_| unreachable!()).unwrap(), "");
}

#[test]
fn vad_segments_keep_only_speech() {
    let pcm: Vec<f32> = (0..10).map(|i| i as f32).collect();
    assert_eq!(audio::speech_only(&pcm, &[(1, 3), (2, 5), (8, 99)]), vec![1.0, 2.0, 3.0, 4.0, 8.0, 9.0]);
    assert!(audio::speech_only(&pcm, &[]).is_empty());
    assert_eq!(audio::duration(16_001), Duration::from_millis(1001));
}

#[test]
fn pcm_resamples_to_16k() {
    let mut pcm = super::super::capture::Pcm::new(48_000, 1).unwrap();
    let tone: Vec<f32> = (0..48_000).map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / 48_000.0).sin() * 0.5).collect();
    pcm.push(&tone);
    let out = pcm.mono_f32_16k().unwrap();
    assert!((out.len() as i64 - 16_000).abs() <= 16, "{}", out.len());
    assert!(out.iter().all(|s| (-1.0..=1.0).contains(s)));
    let peak = out[2000..14_000].iter().fold(0f32, |m, s| m.max(s.abs()));
    assert!((0.4..0.6).contains(&peak), "{peak}");
    // The WAV round trip used by Retry keeps rate and samples.
    let back = super::super::capture::Pcm::from_wav(&pcm.wav().unwrap()).unwrap();
    assert_eq!(back.samples, pcm.samples);
    assert_eq!(back.duration_ms(), 1000);
    assert!(super::super::capture::Pcm::from_wav(b"RIFF").is_err());
}

// ---- worker protocol ----

#[test]
fn frames_round_trip_and_reject_garbage() {
    let req = TranscribeRequest { language: Some("en".into()), filter_silence: true, ..Default::default() };
    let bytes = worker::encode(worker::KIND_TRANSCRIBE, &req, &[0.5, -1.0]).unwrap();
    let frame = worker::read_frame(&mut bytes.as_slice()).unwrap().unwrap();
    assert_eq!(frame.kind, worker::KIND_TRANSCRIBE);
    assert_eq!(frame.pcm, vec![0.5, -1.0]);
    let back: TranscribeRequest = frame.parse().unwrap();
    assert_eq!(back.language.as_deref(), Some("en"));
    assert!(worker::read_frame(&mut [].as_slice()).unwrap().is_none());
    assert!(worker::read_frame(&mut [0xff, 0xff, 0xff, 0xff].as_slice()).is_err());
    assert!(worker::read_frame(&mut [3, 0, 0, 0, 1, b'{', b'}'].as_slice()).is_err());
    assert!(worker::read_frame(&mut [4, 0, 0, 0, 1, b'\n', 0, 0].as_slice()).is_err());
}

#[test]
fn serve_answers_each_request_in_order() {
    let mut input = Vec::new();
    input.extend(worker::encode(worker::KIND_LOAD, &worker::LoadRequest { path: "m".into(), backend: worker::Backend::Auto }, &[]).unwrap());
    input.extend(worker::encode(worker::KIND_TRANSCRIBE, &TranscribeRequest::default(), &[0.0; 3]).unwrap());
    input.extend(worker::encode(worker::KIND_RESET, &serde_json::json!({}), &[]).unwrap());
    input.extend(worker::encode(9, &serde_json::json!({}), &[]).unwrap());
    let mut output = Vec::new();
    worker::serve(input.as_slice(), &mut output, &mut worker::Echo).unwrap();
    assert_eq!(&output[..8], worker::HELLO);
    let mut rest = &output[8..];
    let kinds: Vec<_> = std::iter::from_fn(|| worker::read_frame(&mut rest).unwrap()).map(|f| (f.kind, String::from_utf8(f.header).unwrap())).collect();
    assert_eq!(kinds[0].0, worker::KIND_OK);
    assert_eq!(kinds[1], (worker::KIND_TEXT, r#"{"text":"3 samples"}"#.into()));
    assert_eq!(kinds[2], (worker::KIND_TEXT, r#"{"text":""}"#.into()));
    assert_eq!(kinds[3].0, worker::KIND_ERR);
}
