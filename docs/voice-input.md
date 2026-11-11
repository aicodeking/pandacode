# Voice input

Voice input records a short dictation and inserts its transcript into the composer. It never sends your message automatically. Speech models are separate from the model used by your coding agent.

All voice settings live in **Settings → Voice** (its own entry in the Settings sidebar, after Appearance; the command palette finds it by words such as *whisper*, *parakeet* or *dictation*), in three cards: **Input** (microphone and shortcut), **Transcription** (where audio goes, language and on-device models) and **Speech services** (online or self-hosted services). The first microphone click with nothing set up opens this page with **Send microphone audio to** focused.

## Choose where audio goes

**Send microphone audio to** decides what transcribes your recordings:

- **This device**: a speech model you downloaded runs on your computer. Audio never leaves it. Unavailable (and labelled so) on computers that cannot run local models.
- **Off**: voice input is turned off. Saved models and services are kept.
- **A saved speech service** (for example OpenAI, Groq, Mistral or your own server): audio is sent to that service. See [Speech services](#speech-services).

On Windows on Arm, on-device models need both the Armv8.2 dot-product and the int8 matrix-multiply (i8mm) instructions. Processors without either, such as the Snapdragon 8cx Gen 1–3, can't run them: PandaCode says so in Settings → Voice, marks **This device** unavailable and doesn't offer model downloads. Add a [speech service](#speech-services) and choose it under **Send microphone audio to** to dictate on these computers. The i8mm check uses a processor-feature id that only newer Windows 11 builds report. Older Windows 11 builds and Windows 10 on Arm don't, so on those even capable processors (such as Snapdragon X) are told they can't run on-device models; updating Windows, or using a speech service, resolves it.

On Windows and Linux x64, on-device models need a processor with SSE4.2, AVX and F16C (most made since about 2013; some low-end Pentium and Celeron chips lack AVX). On a processor without them the speech engine stops when a model loads, and the app shows “The local speech engine stopped unexpectedly” and suggests retrying, but on such a processor retrying won't help. PandaCode doesn't detect this in advance; use a speech service instead.

On Linux, the AppImage records through the system ALSA library (`libasound.so.2`), which desktop distributions already include.

A recording always finishes with the destination it started with; changing the setting applies to the next recording.

## Pick languages and a model

The model browser has two lists. Select one or more **languages** on the left (or **All languages**) to see only models that support every one of them; both lists are searchable. Models you already have come first, then downloads in progress, then recommended models.

Each model card shows:

- **Accuracy grade and error %** for each selected language (or the model's best language): the word or character error rate on a standard benchmark, lower is better. Grades run **A** (under 5% error), **B** (under 10%), **C** (under 20%), **D** (under 30%) and **F**; A to C carry **+** or **−** within the band. “Not benchmarked” means no measurement exists for that language.
- **Speed**: seconds to transcribe 30 seconds of audio on the benchmark's GPU. Your computer may be slower, especially without GPU acceleration.
- Number of languages, download size and licence, linked to the licence text. Each model is covered by its own licence; check it fits your use. Models whose licences forbid commercial use or add use restrictions (for example non-commercial models and Google's MedASR) are left out of the catalog.
- Badges: **Recommended** (a good default for its languages), **Live preview** (the model can recognise speech as a stream) and **Translate** (the model can translate speech). Dictation inserts the transcript in the language you spoke when you stop recording.

Not sure? Start with a **Recommended** model for your language. Smaller models download and load faster; larger ones are usually more accurate.

## Download, select, test and delete

- **Download** fetches the model and shows progress, then **Verifying…** while PandaCode checks the file is exactly the published one. A file that fails the check is removed; try again. One model downloads at a time. **Cancel** stops a download and keeps what was fetched, so the next Download resumes. Closing the window keeps a download running; quitting PandaCode stops it and keeps what was fetched for the next Download.
- **Select** makes an installed model the one used for dictation. Selecting a model does not change **Send microphone audio to**; choose **This device** there to use it.
- **Test model** (on the selected model) records a sentence for up to 30 seconds and shows the transcript on the card. Test text never goes into a draft.
- **Delete** (the trash button) asks for confirmation and shows how much space it frees. A model cannot be deleted while it is transcribing, downloading or being tested (stop the model test first); deleting the selected model clears the selection.

The first model download also fetches a small voice-activity model (about 1 MB) that skips silence before transcription; if it is missing, recordings are transcribed as they are.

**Disk space.** Models range from tens of megabytes to several gigabytes; the size is on every card. PandaCode checks free space before downloading and stops with a message if there is not enough. Deleting a model frees its space, including any partial download.

The first dictation after a while loads the model, which can take a few seconds for large models. A loaded model is unloaded after 15 minutes without use.

## Language

With **This device**, **Language** lists **Auto-detect** plus the selected model's languages. Auto-detect lets models that support detection identify the language; a single-language model always uses its language, and a multilingual model without detection uses its default. Pick a fixed language when you always dictate in one language or detection guesses wrong. The note under the menu says what the selected model will do. Speech services have their own optional language in the service's **Advanced** settings.

## Microphone and shortcut

- **Microphone**: **System default** follows your OS setting; pick a specific device to always use it, or refresh the list after plugging one in. A saved device that is unplugged shows as “not connected”. On Linux the list shows `default`, `pipewire`, `pulse`, `jack` and `oss` when present, then each sound card that can record by its card name (such as “HDA Intel PCH”, which opens the card's lowest-numbered `plughw` capture device, or its lowest-numbered `hw` one when it has no `plughw` device). Raw ALSA device ids (such as `hw:CARD=PCH,DEV=0`) are listed only when one is your saved microphone, or when `/proc/asound/cards` is unavailable and card names are unknown; a card name saved by 0.3.108 or earlier and a device id saved by 0.3.109 both still match.
- **Test microphone** records for up to 10 seconds and plays the recording back in Settings. Test audio stays on this device: it is never transcribed, sent anywhere or saved.
- The microphone test and **Test model** cannot run at the same time, and neither runs while you are dictating; a dictation cannot start while either test records.
- **Dictation shortcut** sets how the shortcut records: **Auto** (press to toggle, hold to record), **Hold to record** (records while the keys are held) or **Press to toggle** (press once to start, again to stop).

## Speech services

To send audio to an online or self-hosted service instead, add a profile under **Speech services**. Choose a provider, model and profile name; **Advanced** contains the endpoint and optional language. For a custom service, enter the full transcription URL and model ID it expects. Enter a speech API key when the service requires one, then save and select the profile. Saving alone does not test the key or contact the service. Enter in a profile field saves without selecting the profile; **Save and use profile** is the explicit way to enable it. Deleting asks you to confirm removal of the profile and its saved key. Existing keys can be preserved without reading them back. Changing the endpoint without entering a new key drops the previous credential so it cannot be sent to a different destination; removing a key or deleting a profile removes its stored credential.

Provider suggestions include OpenAI `gpt-transcribe`, Groq `whisper-large-v3-turbo` / `whisper-large-v3`, and Mistral `voxtral-mini-transcribe-3-0`. Availability depends on your account. These identifiers were checked against the [OpenAI transcription guide](https://developers.openai.com/api/docs/guides/speech-to-text), [Groq speech documentation](https://console.groq.com/docs/speech-to-text) and [Mistral model page](https://docs.mistral.ai/models/voxtral-mini-transcribe-3-0) on November 8, 2026. You can enter a custom model ID when your service changes its catalog.

## Record and review

Click the microphone beside Attach and allow microphone permission. During startup and recording, your draft is read-only and its selection stays fixed. The waveform covers the prompt text area; Stop, Cancel and input buttons stay visible. The normal tray returns when transcription starts. Narrow composers keep the tray visible throughout.

**Enter** stops recording and starts transcription. **Escape** cancels startup or recording. **⌘+Shift+D** (macOS) or **Ctrl+Shift+D** starts or stops dictation while focus is in the prompt box, on the microphone button or on the dictation status card. Focused buttons keep their usual Enter/Space actions. IME commit keys do not trigger dictation actions. Clicking the waveform returns focus to the prompt without moving your selection. Send during recording says “Stop dictation to send.”

After Stop, you can type immediately. Speech inserts at the saved selection, or follows the saved text before the cursor when that text still occurs exactly once. Your current typing cursor and selection stay with your text. If the draft changed too much, the transcript waits in review with **Insert at cursor** and **Discard**. Review preserves paragraph and list breaks. In very short windows the draft becomes a shorter scrolling field so the heading, details and actions remain available. Long details scroll with the keyboard; Tab reaches the card actions first.

Committing a non-empty send or explicitly clearing a draft retires its insertion location. An empty Send leaves it unchanged. Speech you stopped before a send stays held until the send succeeds or fails, then appears in review; dictation you start after sending inserts as usual, and speech that finishes after the send settled goes in at the cursor of an empty composer. After edits, speech inserts only where the text on both sides of its place is still there; otherwise it waits in review. A committed send clears its draft immediately, before preparing attachments and context. Everything you type afterwards belongs to the next draft; success leaves it untouched. Failure restores the original message before newer text, separated by a newline, without duplicating an equal draft; several failed messages come back in the order you wrote them. An empty Enter while transcribing shows a brief reminder; an empty Send does nothing.

Switching threads keeps stopped speech with its origin. Leaving while recording stops and transcribes it. The microphone in another thread names the pending work and offers **Go to thread**; the hint stays while focused or hovered. Returning inserts the speech at its saved place if that text is unchanged; otherwise it waits in review with the cursor put back at that place when it can be found. An unsuccessful microphone attempt with no captured audio or text does not block a new attempt in another thread.

Closing the window depends on what closing does. When it only hides the window (the menu-bar item keeps PandaCode running), a recording dictation stops and is transcribed, ready when you come back. When closing quits PandaCode (always on Linux; on macOS and Windows only if the menu-bar or tray icon couldn't be created), as does quitting the app, a dictation that is still recording is cancelled and its audio isn't uploaded, and a transcription still in progress is lost; audio already sent to a speech service for transcription can't be recalled.

**Cancel**, **Discard** or deleting the origin thread discards speech. Escape on a transcribing status card keeps it; on an error card it keeps the recording for Retry; in review, Escape discards only while focus is inside the card. Settings and menus handle Escape before dictation. Disabling voice input during startup or recording cancels it. Stopped audio and review text survive settings changes, including deleting a profile. **Retry** uses the retained recording and its original provider settings; **Record again** discards it and uses current Settings.

Silence shows a calm baseline; Reduced Motion uses a static waveform. The clock keeps the recorded duration during transcription and shows a waiting reminder after ten seconds. Recordings are limited to two minutes and 16 MiB; reaching a limit stops capture without transcribing until you choose **Transcribe recording**. Review the draft before sending: dictation never sends automatically. Native Undo can group adjacent typing and dictation into one step.

## Your own speech server

The simplest offline option is **This device** with a downloaded model. If you prefer to run your own speech-to-text server, install and run it yourself, following that project's instructions and model license. A service accepting WAV multipart uploads with `file`, `model`, optional `language`, and JSON `{ "text": "…" }` is required. A generic text-generation/chat endpoint is insufficient.

Select **Local or custom server**, enter the server's full route (for example `http://127.0.0.1:8080/inference` if your server implements that route), and enter its actual model ID. Some compatible servers instead expose `/v1/audio/transcriptions`; consult your server's documentation. Leave API key empty only when your server permits unauthenticated requests. Local HTTP must use a literal loopback address such as `127.0.0.1` or `[::1]`; the name `localhost` is refused, so write the address instead. Remote services require HTTPS. Redirects are refused, so enter the final URL. The URL must include a path and must not contain a query string, credentials or a fragment. If you enter an API key, it is sent as `Authorization: Bearer <key>`. Test with a short recording after the server is ready. A server can itself forward audio elsewhere: local hosting alone does not guarantee offline processing.

For example, after building [whisper.cpp's server](https://github.com/ggml-org/whisper.cpp/blob/v1.8.3/examples/server/README.md) and obtaining a model yourself, start it in your whisper.cpp checkout:

```sh
./build/bin/whisper-server --host 127.0.0.1 --port 8080 -m models/ggml-tiny.en.bin
```

Then configure `http://127.0.0.1:8080/inference` in PandaCode. Substitute the model file you actually installed; `tiny.en` is an English model. For whisper.cpp, loaded weights come from the server's `-m` option (or its own load API). Changing PandaCode's model field does not switch those weights. Other servers may route by model ID; follow their own documentation. PandaCode does not download the example model or run this command for you.

## Privacy and troubleshooting

No voice request, model download or microphone access happens at launch, while browsing settings, or when saving profiles. Models are downloaded from Hugging Face only when you click **Download**. Recording starts only on your action. With **This device**, audio is transcribed on your computer and never leaves it. With a speech service, audio is sent directly to that service when you stop or transcribe a recording (Stop, Enter, **Transcribe recording**, Retry) or when switching threads or anything else closes the prompt box mid-recording while PandaCode keeps running (such as closing the window to the menu bar or tray), with the selected model, optional language and credential; the provider's own retention and billing policies apply, and cancelling cannot recall audio it already received. Automatic stops (the two-minute or 16 MiB limit, or a failing microphone) send nothing and keep the audio until you choose **Transcribe recording**.

Credentials stay in native secret storage and are never returned to the webview or ordinary profile settings. Audio is held in bounded memory, not saved as a recording; failed audio remains available for Retry until it succeeds, you discard it, choose Record again or delete the thread the dictation started in, or PandaCode quits. The transcript becomes ordinary draft/message content when you insert/send it. Changing a profile during capture cannot redirect that capture's audio, and a settings read that fails never cancels a recording.

For permission failures, enable PandaCode in your OS microphone privacy settings and retry. If a local model fails to load or transcribe, try **Test model**, pick a smaller model, or delete and download it again. For service failures, verify the final URL, server readiness, supported model, key and account access. Speech-service uploads and model downloads connect directly and ignore system and HTTP proxy settings, so on a network that requires a proxy they fail. Browser preview uses synthetic audio/events and cannot establish that native hardware capture, OS permissions or a real service work.
