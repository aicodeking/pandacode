# Browser

The Browser tab opens beside the conversation. Its start page lists local TCP
listeners with process names and ports; refresh runs discovery once. Open a listed
server or enter an HTTP(S) URL, hostname, or localhost port in the address bar.
Back, forward, reload, element selection, and viewport capture stay in the toolbar.
Some listening ports are not HTTP servers and may not serve a page.

PandaCode creates one system webview only after navigation and destroys it when
the Browser tab closes. Page content has no application IPC permissions. App menus
and dialogs temporarily hide the guest view so native content cannot cover them.
There is no bundled browser engine, proxy server, or idle port polling. Browser
history and cookies are ephemeral in this first version.

The guest is a child webview of the main window, and Tauri only resolves a
`WebviewWindow` for a window whose webviews all share its label. While this tab is
open, a command that asks for `tauri::WebviewWindow` fails with "current webview is
not a WebviewWindow". Workspace commands take the calling `tauri::Webview` and
check its label instead (`is_main_webview` in `src-tauri/src/lib.rs`).

Element selection highlights the hovered element and consumes the next click.
Escape cancels it. The attached context contains the page URL, title, CSS selector,
tag, bounded text, a sanitized markup summary, and element bounds. Form values,
editable text, scripts, and hidden descendants are excluded. Page context is
explicitly labeled as untrusted content in the message.

Screenshot captures use WKWebView's visible-viewport snapshot on macOS. PNGs live
in the application's private cache; the renderer sends capture UUIDs, not arbitrary
paths, when submitting the message. Up to four screenshots may accompany a turn,
with a 5 MiB per-image and 12 MiB total limit. Pending screenshots have a shared
renderer memory budget. Attachments are removable before sending and stay with
their originating task when switching conversations. Capture does not send a model
request; the user sends the completed message.

Claude receives base64 image content, Codex receives localImage input, and Kimi
receives ACP image blocks after its capability check. Unsupported models surface
their provider's error. Image bytes are not included in the saved text transcript.

macOS provides the complete native browser and snapshot workflow. Other desktop
platforms can navigate and select elements; native screenshot capture reports its
platform limitation. Local listener discovery uses lsof on macOS/Linux; Windows
discovery is not implemented. Browser-mode development previews use explicitly
labeled fixtures, not external page access.

References: [Tauri child webviews](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html),
[Tauri capabilities](https://v2.tauri.app/security/capabilities/),
[WKWebView snapshots](https://developer.apple.com/documentation/webkit/wkwebview/takesnapshot(with:completionhandler:)),
[Claude image input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode),
[ACP image content](https://agentclientprotocol.com/protocol/v1/content).
