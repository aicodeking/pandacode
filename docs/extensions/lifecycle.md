# Local package lifecycle (experimental)

## Transaction design

Updates are explicit local ZIP selections, not background downloads. Validate before
staging; keep the selected archive usable until review and drain complete. Review
is bound to the candidate checksum and lists added permissions and executable
authority. A checksum is integrity, not publisher trust.

The atomic installation record owns the selected archive, a bounded staged
candidate, one prior compatible archive/state checkpoint and, after an update,
the private settings/state value. Keeping package selection and private state in
one rename avoids a two-file commit that could select new code with old state (or
the reverse). Legacy private files are imported on the first update; core SQLite
history is never part of this transaction. Separate archive/state renames and
in-place archive replacement were rejected because they cannot provide this
recovery guarantee. Only one rollback generation is retained.

Provider runs verify the captured digest and acquire a lease under the package
manager lock before execution. Update activation and uninstall wait for leases to drain; no new runs
are admitted while removal or approved activation is pending. Existing runs use
their immutable captured source, keep their core cancellation/input ownership,
and release the lease even on early failure. Cancellation is explicit, never an
implicit side effect of staging an update. A second selection cannot overwrite
an unreviewed candidate.

An executable update is provisional until its first managed activation succeeds.
Failure restores the prior package and state checkpoint; a launch interrupted
during probation recovers that checkpoint before enumeration. Irreversible public
API migrations remain rejected. Manual rollback uses the same atomic record
promotion and is blocked while provider leases exist. Trusted native code can
independently change user files: these guarantees cover host-managed package and
API state, not arbitrary external effects or a security sandbox.

Safe mode bypasses package loading before enumeration and restores built-in
presentation; it preserves package records, projects, tasks, drafts and terminals.
Installed/platform qualification remains deferred by the user's scope decision;
browser previews are synthetic, not installed WebView evidence.

## Manager workflow and limits

1. Open Settings → Extensions → **Stage update** and select a local ZIP with the
   same extension ID. Staging runs no code and does not replace the selected version.
2. **Review staged update** shows both versions, the candidate SHA-256, added API
   permissions and, for native code, the complete normal-account authority warning.
   Cancel/Escape does not approve. Confirmation approves only that candidate.
3. The manager shows the pinned run count and why activation/removal is waiting.
   Existing provider approval/input/Stop controls remain core-owned. Finish the run,
   or explicitly use Stop; staging and uninstall never manufacture a second run.
   Disable/revoke is a separate explicit cancellation operation. Disabling during
   drain cannot be undone by the older staged enable preference.
4. **Discard staged update** retains the current version. **Roll back** restores
   the previous compatible package/private-state checkpoint after provider drain.
   Failed graph validation quarantines the candidate without replacing old code.
   Provisional activation failure restores the checkpoint; dependencies that would
   prevent this recovery cannot be enabled during probation. If startup cannot
   recover a provisional record, it falls back to safe mode rather than running it.
5. Uninstall retains private data, including state imported into the installation
   record, in the existing owner-private store. Private-data deletion is separate
   and refused while a pinned installation still exists. No core history is removed.

The existing archive limits remain 2 MiB compressed, 1 MiB expanded, 64 files and
256 KiB per file. One record is bounded to 9 MiB for selected/candidate/prior
archives and 128 KiB private-state checkpoints; only one prior generation is kept.
Interrupted `.stage` output is never enumerated as an installed package. These are
host-managed API guarantees, not undo of arbitrary file/network/process effects
from explicitly trusted executable code. No catalog, update polling or network
request was added.
