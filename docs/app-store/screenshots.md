# App Store screenshots

## Sizes and App Store Connect slots

Apple's spec: https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications.
PNG or JPEG, RGB, no alpha, up to 10 per size. A wrong size fails the upload ("resolution not
supported").

| App Store Connect slot | Folder (`docs/app-store/screenshots/`) | Pixels | Needed |
|---|---|---|---|
| iPhone 6.3" (Dynamic Island, medium display) | `iphone-6.3/` | **1206 × 2622** portrait | **Required** |
| iPhone 6.9" (Dynamic Island, large display) | `iphone-6.9/` | **1320 × 2868** portrait | Optional; shown on the larger iPhones instead of a scaled 6.3" set |
| iPhone Duo, outer display | `iphone-duo-outer/` | **1398 × 2034** portrait | Optional now; required for apps built with the iOS 27.1 SDK from April 2027; adds the "Optimized for iPhone Duo" badge |
| iPhone Duo, inner display | `iphone-duo-inner/` | **2853 × 2007** landscape | Same as outer |
| iPad 13" | none | 2064 × 2752 | No |

Upload each folder's files in file order; the first three show in search results.

Why no iPad: `mobile/app.json` sets `ios.supportsTablet: false`, so the build is iPhone only.
App Store Connect then asks for no iPad screenshots. iPads can still install it and run it in
the iPhone-size window; that needs nothing from us. If `supportsTablet` ever becomes `true`,
the 13-inch iPad set becomes required and the split view (`src/ui/split.tsx`) is the layout to
shoot.

Rules:

- Check sizes before uploading:
  `sips -g pixelWidth -g pixelHeight -g hasAlpha docs/app-store/screenshots/*/*.png`
  (`hasAlpha: no` everywhere). `render.mjs` also fails if a file comes out at the wrong size.
- iPhone shots are portrait. Duo inner shots are landscape (the split view); outer shots portrait.
- Real app UI from the demo (Explore the demo, or `EXPO_PUBLIC_PANDACODE_DEMO=1`). The demo's
  computers, projects and logins are fictional, so no personal data shows. A caption and a
  device frame around the UI are fine; don't show features the app doesn't have (2.3.3).
- Status bar in captures: full battery, full signal, 9:41. In the simulator:
  `xcrun simctl status_bar <udid> override --time 9:41 --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3`.

## iPhone sets (6.3" and 6.9")

The same six pages at two sizes. Each is a two-line caption above a phone frame holding one
capture from `docs/app-store/mockups/captures/`. Light and dark alternate.

| # | File | Capture | Caption (line 1 / line 2) |
|---|---|---|---|
| 1 | `01-inbox.png` | `inbox-light.png`: the Inbox across computers | Every agent, / one inbox. |
| 2 | `02-task.png` | `task-dark.png`: a task's conversation | Talk to the agent, / not the laptop. |
| 3 | `03-approval.png` | `approval-light.png`: a task waiting on an approval | Approve tool calls / from anywhere. |
| 4 | `04-working.png` | `working-dark.png`: a run in progress | Watch it work, / live. |
| 5 | `05-new-task.png` | `new-task-light.png`: New task, choosing a computer | Pick a computer, / start a task. |
| 6 | `06-settings.png` | `settings-dark.png`: Settings, appearance and wallpaper | Light, dark, wallpaper. / Make it yours. |

## iPhone Duo sets

Captured on an iPhone Duo simulator (Xcode 27.1, iOS 27.1) in demo mode, from
`docs/app-store/mockups/captures/duo/`. The headline sits above a plain rounded device outline.

Inner display, `iphone-duo-inner/` (2853 × 2007, landscape split view: sidebar, pane, glass rail):

| # | File | Capture | Headline |
|---|---|---|---|
| 1 | `01-side-by-side.png` | `inner-task-dark.png` | Your inbox and the agent, side by side. |
| 2 | `02-approval.png` | `inner-approval-light.png` | Approve tool calls without losing your place. |
| 3 | `03-working.png` | `inner-working-dark.png` | Every task in view, watch one work. |
| 4 | `04-new-thread.png` | `inner-new-light.png` | Pick a project, start a task. |
| 5 | `05-settings.png` | `inner-settings-dark.png` | Light, dark, wallpaper. Make it yours. |

Outer display, `iphone-duo-outer/` (1398 × 2034, portrait single column):

| # | File | Capture | Headline |
|---|---|---|---|
| 1 | `01-inbox.png` | `outer-inbox-light.png` | Every agent, / one inbox. |
| 2 | `02-task.png` | `outer-task-dark.png` | Talk to the agent, / not the laptop. |
| 3 | `03-approval.png` | `outer-approval-light.png` | Approve tool calls / from anywhere. |
| 4 | `04-working.png` | `outer-working-dark.png` | Watch it work, / live. |

Capturing Duo screens:

1. `xcrun simctl create 'Duo Shots' com.apple.CoreSimulator.SimDeviceType.iPhone-Duo`, boot it,
   install a simulator build (`npx expo run:ios -d <udid>`, or an existing
   `Debug-iphonesimulator/PandaCode.app` with `xcrun simctl install`), set the status bar as above.
2. Open the app and tap **Explore the demo**. Light/dark: `xcrun simctl ui <udid> appearance light|dark`.
3. Fold or unfold: `simctl` has no fold command. Use PandaCode's simulator tools
   (`pandacode_simulator_manage` action `pose`: `closed` shows the outer display, `open` or
   `book` the inner one in landscape) or the fold control in Simulator/Xcode's Device Hub.
4. The two displays are separate screens: `xcrun simctl io <udid> screenshot --display=primary out.png`
   is the outer display (1398 × 2034) and `--display=primary-1` the inner one (2853 × 2007,
   already landscape). Both come out at the App Store size.
5. A fresh launch avoids a dev-build warning toast and a stray black circle that can appear in
   the inbox header rail after navigating back to it; check each capture before using it.

## Re-rendering

Sources are in `docs/app-store/mockups/`:

- `index.html`: the iPhone page (`index.html?<n>` shows shot n; the `shots` table holds each
  caption and capture), styled by `mockup.css`, laid out at 1320 CSS px wide.
- `duo.html`: the Duo page (`duo.html?inner&<n>` or `duo.html?outer&<n>`; its `shots` table
  holds headlines and captures from `captures/duo/`). It reuses `mockup.css` for the paper,
  bamboo and type.
- `render.mjs`: the list of sets (folder, page, pixel size, design width, file names).

To change a caption, edit `shots`; to change a screen, replace its capture with a new screenshot
of the same name. Then, from the repo root:

```sh
node docs/app-store/mockups/render.mjs                 # every set
node docs/app-store/mockups/render.mjs iphone-6.3      # one or more sets by folder name
```

It uses the repo's Playwright with Google Chrome (`channel: 'chrome'`). Each page is laid out
at its design width and scaled to the set's size with `deviceScaleFactor`, so 6.9" and 6.3"
come from the same layout. It overwrites the files in each set's folder and stops with an error
if any PNG is not the exact size. To add a size, add a line to `sets`.

## App preview video (optional)

Not planned for 1.0. If you add one: 886 × 1920 portrait, 15–30 s, H.264, recorded from the demo.
