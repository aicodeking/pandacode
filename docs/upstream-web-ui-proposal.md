# Proposal: an authenticated browser workspace backed by the native PandaCode runtime

Prepared locally for upstream discussion; not published.

PandaCode's existing browser preview uses fixture data. Tablet users currently
need a remote desktop to use their actual projects, providers and running tasks.
This proposal adds an opt-in browser workspace that reuses the desktop frontend
and connects to the existing native runtime through a same-origin gateway.

The intended result is the same task, settings and theme behavior on a tablet,
without a second database writer or copied provider credentials. Native system
chrome remains platform-specific; its workspace actions need browser equivalents.

The implementation uses a finite command registry and the existing typed Tauri
wrappers through a native main-window broker. The network cannot construct IPC,
evaluate arbitrary JavaScript or call gateway lifecycle commands. Authentication
uses expiring one-time pairing codes, server-side sessions, Secure/HttpOnly
cookies, CSRF checks and strict configured Host/Origin validation. Event replay,
mutation request IDs and host-owned automatic work prevent duplicate submissions
when multiple viewers reconnect.

Appearance synchronization exports only validated theme/palette/wallpaper/scale
settings. File selection uses rooted browsing and session-bound grants rather
than accepting arbitrary filesystem paths. Browser uploads require explicit
purpose, byte/quota limits and host-local private staging. Existing provider
secret storage remains on the native host.

Before proposing a merge, verification must cover real authenticated HTTP/WS,
projects/history/chat/streaming/stop/approvals, models/providers, files/diffs/Git,
PTY ownership and cleanup, attachments, settings/themes, automation/teams/remote
and supported console workflows. Browser tests must include WebKit, keyboard
spaces/IME, scrolling/selection, rotation and disconnect recovery. Fixture-only
screenshots and an HTTP health response are insufficient for acceptance.

Current status: implementation and tests are in progress. Registry coverage is
exhaustive; shared browser adapters and isolated native checks are implemented.
Real-provider, external authenticated HTTP/WS, physical-device and broad workflow
acceptance remain outstanding before a merge proposal.
No full-parity or production-readiness claim is made.
