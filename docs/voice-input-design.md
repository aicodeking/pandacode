# Voice input design

Desktop dictation inserts a transcript into the existing draft. It never sends the message automatically. Speech profiles are independent of coding-agent configuration.

## Ownership and privacy

The native layer owns microphone permission, bounded in-memory audio, credentials and transport. Recording starts only after an explicit user action. Stop or Retry transcribes with the destination snapshotted at Start: **This device** runs a downloaded model in an on-device speech worker (transcribe.cpp, linked statically) and audio never leaves the computer; a saved speech service receives audio directly from the native layer. Saving settings does not make a voice request. Credentials never reach the webview.

Each capture snapshots its profile, endpoint, language and credential. Requests and results carry capture identity, thread identity and a navigation generation. Thread navigation, composer destruction, explicit discard and voice disable invalidate pending results. Draft edits and submission never discard a stopped capture. A new Start waits for pending cancellation. Transcription waits for the latest configuration refresh before inserting.

Audio is limited to two minutes and 16 MiB. Transport accepts HTTPS or literal loopback HTTP, refuses redirects, bounds response size and has a timeout. Those transport rules apply to speech services; on-device transcription needs no service, only a downloaded catalog model (see [voice-input.md](voice-input.md)). Failed audio stays available only when the native failure explicitly marks it retryable.

## Composer behavior

The microphone control sits beside Attach. During recording the draft remains mounted and read-only, preserving its text and selection; submission is blocked. Enter stops and transcribes, Escape cancels startup or recording, and IME commit keys do not invoke either action. Stop returns focus to the draft immediately, while a held Enter cannot submit it.

Stop saves text before and after the selection. Successful transcription inserts at that selection if the draft is unchanged and usable, or, after edits, where the saved text still frames the place on both sides or the edit lay wholly before or after it; one-sided context must be at least 8 characters and match exactly once. Otherwise the transcript stays in review with explicit Insert at cursor and Discard actions. Typing, slash completion, clears, sends and failed-send restores never cancel it. Empty Enter while transcribing gives a brief hint; empty review sends do nothing. Escape in the draft after Stop preserves the transcript; Escape inside its card discards it. A temporarily disabled draft must not strand the transcript. Retry resends retained audio with its original profile; Record again uses current settings.

The controller owns capture state, the key module owns input guards, and the pill module owns rendering and timers. The canvas renderer owns layout sizing, display density, palette observation and animation cleanup. It covers the prompt text area while buttons remain visible, draws inside text padding, and uses bounded measured history with time-based attack, release and scrolling. Both frame advancement and static sampling return new immutable state; bars fade at the leading edge. It falls back to rectangular bars when rounded canvas paths are unavailable; if the drawing context is unavailable, the read-only draft stays visible. Reduced Motion uses static samples; hidden documents and inactive captures run no animation frames. Appearance uses design tokens and system text color under forced colors.

## Verification

Run the typecheck, production build, unit tests (including the speech catalog tests) and voice browser suite in Chromium and WebKit. Regressions cover capture ownership, cancellation, overlapping configuration refreshes, immediate typing after Stop, disabled-draft recovery, IME and held keys, layout dimensions, display density, palette contrast, reduced motion, fallback drawing and cleanup.

Run `node scripts/speech-catalog.mjs --source <package dir> --check` against `@handy-computer/models@0.2.3` and the Rust voice tests for the on-device engine and catalog.

Browser preview uses synthetic events and transcripts. Passing these tests does not establish native microphone, operating-system permission, on-device model download or transcription, or real speech-service behavior.
