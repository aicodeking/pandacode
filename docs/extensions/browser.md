# Browser presentation v1

Design decision: use a closed `controls-below` recipe on `panda.browser`, not
package HTML or a new engine. The recipe moves the original toolbar below the
original viewport. Host navigation, native guest, bounds, overlay visibility,
Jev ownership and platform checks remain unchanged. Arbitrary guest relocation
and guest DOM access are rejected alternatives: neither preserves native ownership.

`browserPresentation` captures a mount context, opaque guest handle, project,
task/session and revision. `browserAction` repeats those identities and a unique
request ID. Grant, owner, activation, visibility, revision, pending and replay
checks precede the original navigation/action handlers. Invalid arguments,
unsupported actions, revoked owners, stale identities and replay have explicit
reasons. Hiding a control is presentation, not revocation. Recipe changes never
navigate or close the guest. Dispose revokes the adapter and uses normal host cleanup.

`panda.browser.controls` catalogues original controls; `panda.browser.actions`
and `panda.browser.context` accept ordinary declarative commands. URL entry
remains the original input. Pick context is limited to eligible tag and bounded
plain text after a host pick; no selector, HTML, screenshot bytes, credentials or
DOM handle is public. This closed recipe has no arbitrary content endpoint.

Focus moves to a surviving host control when customization hides the focused
control. Restore, conflict, fault, disable and safe mode retain original nodes.
Linux's system-browser fallback remains a platform restriction, not an extension
permission. Automated preview continuity is synthetic; installed WebView2,
WKWebView and Linux guest qualification are deferred outside this run.

Host `browser-state` and `browser-element` events advance the snapshot revision;
selected owner/version/activation, control layout and provider changes invalidate
captured actions as well. Snapshots resynchronize by a fresh read (no incremental
guest event/content channel). Navigation clears picked context. Hidden Browser
hosts suspend the existing Jev watch lease and frame delivery without cancelling
the test; restore renews that lease with the same selected run and frame node.
The host location row owns the contributed context menu. The native website's
own context menu is not replaced or intercepted.
