# Search presentation v1

`panda.search` is an explicitly selected, closed `results-first` host recipe.
It moves the original result region ahead of the original form; it never clones
the input, executes a query itself, or owns document navigation. The form remains
mounted across preference/provider changes, preserving IME, caret and focus.
Conflicts do not select a provider. Disable, safe mode and qualification failure
restore the original ordering without rerunning a search.

The JSON-only `searchPresentation` and `searchAction` contracts capture a host
instance, project/task context, query, options, revision and opaque result IDs.
Actions are query, submit, matchCase, wholeWord, regex, open and collapse. They
delegate to the original scheduler, search_files/search_text and open handlers.
Unknown, stale, forged, wrong-owner, ungranted and revoked actions fail closed.
Query/options invalidate outstanding requests immediately, not after debounce.
Delivery additionally compares captured context/query/options, so switching away
while an RPC runs cannot deliver old results into another checkout.

Presentation pages contain at most 64 result identities with path and line
metadata, never matching source text. `projects.files.metadata` is required for
these pages independently of `ui.contribute`. Opaque revision-bound cursors fail
with `ResyncRequired` after any state change; consumers restart at the first page.
The public contract is a pull snapshot/page protocol, not a lossy event stream.
Original backend content limits remain unchanged. No package content endpoint,
DOM, selector, raw IPC or replacement search engine is introduced.

`panda.search.controls` exposes query and option visibility/order (submit is the
original form action, not an invented extra button);
the existing `panda.inspector.search.toolbar` supplies independent declarative
actions. Existing result context slots remain valid. Hidden controls do not revoke
actions. Moving the host regions uses CSS order, not remounting or a second form.

Rejected alternatives: package-owned query execution would duplicate business
policy; cloned forms would lose composition/undo; result text delivery would
unnecessarily widen content authority. Arbitrary docking is not a compatible
placement contract here: the only v1 move is results/form order in the Search view.
