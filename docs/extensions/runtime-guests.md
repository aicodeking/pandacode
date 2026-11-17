# Control virtual machine, simulator and browser guests (`guests.control`)

Runtime phase R4, slice R0410. A trusted background service lists the guests the app already has (local virtual
machines, iOS and Android simulators and the browser guest), takes a capture of one, sends it scripted input and starts,
stops or navigates it. The permission is `guests.control`: global (not project scoped), granted with the trust decision,
rechecked natively on every request and once more right before a guest is captured, driven or changed, revocable by the
user. A package that holds it is never asked again per action (ADR-0005).

```js
const { kinds, guests } = await panda.guests.list();          // kinds: [{ kind, supported, reason? }], guests: [{ id, kind, name, state, interactive }]
const shot = await panda.guests.capture('simulator:<udid>');  // { path, mime, bytes, width?, height? }: a file in this package's data directory
await panda.guests.input('vm:dev', { action: 'click', x: 10, y: 10 });
await panda.guests.control('vm:dev', 'suspend');
```

A guest id is `<kind>:<name>`: `vm:<Tart name>`, `simulator:<udid>` and `browser:page` (the one browser guest, listed only
while a page is open).

| Call | Does |
|---|---|
| `list()` | the kinds this platform has (and why a kind is missing) and every guest, with its `state` and whether it is `interactive` |
| `capture(id)` | writes the current screen as an image in the package's data directory and answers its path |
| `input(id, input)` | one input in the shape the built-in panel takes for the kind |
| `control(id, action)` | a power or navigation action of the kind |

Inputs: a **VM** takes the computer-use action (`click`, `double_click`, `right_click`, `middle_click`, `move`, `drag`,
`scroll`, `type`, `key`, with `x`, `y`, `endX`, `endY`, `direction`, `amount`, `text`, `keys`); a **simulator** takes
`{ kind: 'tap' | 'longPress' | 'swipe' | 'type' | 'button' | 'key' | 'tapLabel', ... }`; the **browser guest** takes
`{ action: 'read' | 'click' | 'type', selector?, text? }` and answers what the page returned. Control actions: VM `start`,
`stop`, `suspend`; simulator `boot`, `shutdown`, `light`, `dark`; browser `back`, `forward`, `reload`, `stop`. There is no
`delete`: removing a VM stays in the VM panel, where the irreversible deletion keeps the host confirmation.

## Captures never cross the channel

A frame does not fit a channel message. `capture` writes the image to
`<data directory>/guests/<kind>-<id>.<png|jpg>` (the package's own global data directory, the one `panda.storage.directory`
answers) and the reply carries only the path, the mime type, the byte size and the pixel size. The package reads the file
itself. The newest 32 captures are kept; an image over 16 MiB is `LimitExceeded`. A revoke while the image is being taken
removes the file and answers `PermissionDenied`.

## Platform capabilities and failures

Each kind is a platform capability, not a trust decision, and `list` says which are present:

| Kind | Present when |
|---|---|
| `vm` | Apple silicon macOS with Tart installed |
| `simulator` | macOS with Xcode's simulator tools |
| `browser` | a desktop window (not the headless host) on macOS, Windows or Linux |

| Refusal | When |
|---|---|
| `PermissionDenied` (`path`: `guests.control`) | no grant, a revoked grant, a disabled package, safe mode |
| `UnsupportedCapability` | the id names a kind this platform lacks (or does not have at all) |
| `NotFound` | the kind is supported but no guest has that name |
| `Conflict` | `capture` or `input` on a guest that is not interactive (a VM the app did not start, a simulator that is not booted); `control` still works on it |
| `InvalidShape` / `LimitExceeded` | an unknown call, field, action or input shape / a text over 8192 bytes or an input over 16 KiB |
| `HostUnavailable` | the built-in controller failed (Tart, `simctl` or the page did) |

Size and count bounds are for predictability and fault isolation only.

## Revoke and safe mode

Revoking the permission, disabling the package or entering safe mode ends **package control** only. The guests themselves
are never stopped, closed or reset by that: the user's own VM, simulator and browser keep running, and the built-in
panels work exactly as in the original at 0.3.128 (no extension, all disabled and safe mode are the same behaviour). There
is deliberately no hook that stops a guest when a service ends.

## Where each part runs

- **Native** (`src-tauri/src/extensions/runtime_guests.rs`): the shape, the frozen refusals, the platform table, the
  permission check (before and just before the guest is touched) and the capture store. The app half only adds the grants
  file, the data directory and the built-in controllers: `vm::Vms` (frames through `screen::screenshot`, input through
  `screen::act`, `start` / `stop` / `suspend`), `simulator::Simulators` (`screenshot`, `input`, `boot`, `shutdown`,
  `appearance`) and the browser guest (`browser_capture`, `browser_inspect`, `browser_action`, called with the main
  webview as the caller). Native unit tests are `runtime_guests::tests`, over a fake backend that records each call.
- **Preview** (`src/extensions/runtime-guests.ts`): the same rules over fake guests, for
  `tests/extensions-runtime-guests.spec.ts`. No IPC is added, so there is no preview mock.
- **Fixture** (`tests/fixtures/extensions/runtime-guests`): a service that lists the guests, scripts a capture and one
  input per interactive guest and reports every refusal.

Real guests (a started VM, a booted simulator, a page) are an installed-platform qualification, reported separately; no
test here starts one.

## Refusals that stay (Q019, Q093)

The checks that refuse `frame`, `input`, `credentials`, `screen` and `clipboard` in a contributed VM, simulator or browser
component payload (`contracts.rs` and `extensions-vm`, `-simulator` and `-browser` tests) stay. A contributed component is
declarative display data drawn by a panel, not a carrier for a guest's pixels and input; the guest path is
`panda.guests.*` in a service, under `guests.control`. The refusals of a foreign owner, a stale revision and a revoked
grant stay too, each for its own non-security reason: a panel is not a service, a stale revision is a race and a revoked
grant is the user's decision.
