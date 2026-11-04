# Wallpapers

The thread is a window. By default it shows a live sky that follows the local time of day (sun, clouds, dawn and dusk, moon and stars); the clouds pick up wind while the agent works and part around the pointer. **Settings → Appearance → Wallpapers** (off by default) swaps the sky for PandaCode's 21 original anime scenery wallpapers: seven weekday sets with a morning, afternoon, and night scene each. The scene shows inside the conversation panel and the project board; the sidebar and the frame around the panels keep one fixed tint (translucent over the desktop on macOS). The toolbar and status bar are transparent and have no divider while a wallpaper is visible. Thread surfaces use translucent tints so the scenery carries through the composer, subagent panel, code blocks, and attachments. Rounded board task cards share the sidebar and thread panel's frosted material, with translucent hover, selection, and pressed states. Card text remains opaque; Start/Retry controls use translucent backgrounds without an additional blur. Disabling wallpapers or requesting increased contrast/reduced transparency restores solid cards and removes their blur. The inspector retains its normal surface.

## Schedule and preferences

With the switch on, wallpapers follow the computer's local weekday and time:

| Period | Local time |
| --- | --- |
| Morning | 06:00–11:59 |
| Afternoon | 12:00–17:59 |
| Night | 18:00–05:59 |

At midnight the weekday changes, selecting the new day's night scene. The app also checks the current local time when its window regains focus or becomes visible, so it catches up after sleep or a timezone change. A scene does not change with the light/dark theme; the interface's protective treatment changes instead.

Turn on **Settings → Appearance → Wallpapers** for a live preview and these controls:

- **Wallpaper visibility:** drag or use the arrow keys to blend from **Solid (0%)** to **Wallpaper (100%)**. The default is 20%, keeping the original muted appearance. Zero removes the wallpaper image and restores normal workspace surfaces; 100% removes the protective scrim entirely. Text and controls remain fully opaque.
- **Wallpaper blur:** soften the scenery from **Sharp (0 px)** to **Soft (24 px)**. Blur is saved independently of visibility, set, or favorite; changing it never turns a disabled wallpaper on. Existing preferences start at zero blur. The preview scales the blur for its smaller size. Only wallpaper images are filtered, and they extend three blur radii beyond the workspace to avoid faded edges. Text, controls, and conversation content remain sharp.
- **Automatic:** use all seven sets on the weekly schedule above.
- **A weekday set:** keep that set and switch between its three scenes as the local time changes.
- **A default wallpaper:** choose a morning, afternoon, or night card to keep that single scene across all times and days. **Resume rotation** returns to the selected set's schedule; choosing Automatic resumes the full weekly rotation.

Settings also includes an on/off switch that preserves the selected set and favorite. Wallpapers saved before the live scenes arrived start switched off, with their choices kept: turning the switch on brings them back and stays on. Selecting a scene turns wallpapers on; choosing Solid leaves the selection saved for later. Visibility, blur, set, favorite, and enabled state are stored in `pandacode.wallpaperPreferences` and restored on launch. Saves carry `version: 2`; an older save still at the untouched defaults (on, 20%, sharp, automatic) migrates to off, and one the user customised keeps its on/off choice. The earlier `pandacode.wallpapers` flag is still written for compatibility. Invalid saved values fall back to validated defaults; only the 21 bundled scene identifiers can be selected. Changes synchronize between app windows.

A request for increased contrast or reduced transparency automatically uses the solid surface and explains the override in the picker, without overwriting the saved choice. Reduced motion skips the transition.

## Readability and loading

Each generated composition reserves broad calm central space and places most detailed or luminous features at its edges. Theme-aware scrims protect thread text and board labels. The sidebar, composer, and floating subagent panel use a modest backdrop blur; inline code, tool output, attachments, and notices use unblurred translucent tints. Text stays fully opaque. Board thread panels share the sidebar's tint and blur, including the narrow overlay layout. Rounded corners and a small inset soften the panel without a left divider or heavy shadow. Disabling wallpapers restores the normal interface, including native sidebar vibrancy when available. Increased contrast or reduced transparency uses solid materials. Decorative images are hidden from assistive technology and do not intercept input.

Only the current full-resolution scene is loaded, shared by both views. During a change, the next image is decoded before a brief 700 ms fade, then the previous image is released. There is no preload of all 21 images, no animation frame loop, and no continuously polling interval. The next calendar boundary schedules a one-shot update; pinned wallpapers need no timer. Missing or undecodable assets retain the last good scene, or the solid surface if none has loaded.

The picker code and styles load only when opened. It uses separate 360-pixel thumbnails, not the full workspace assets. Slider input updates CSS values and existing controls directly without rebuilding the dialog, composer, or conversation. Preferences save on completion of the gesture or dialog close rather than writing storage on every pointer movement. Closing the picker removes its listeners and thumbnails.

## Assets and generation

All 21 wallpapers were generated individually with **built-in GPT Image** and visually inspected. The complete prompts and portable final asset paths are recorded in [wallpaper-prompts.json](wallpaper-prompts.json). Images contain no requested characters, branding, text, or interface elements.

Runtime files live in `public/wallpapers/{day}-{period}.webp`. Original PNGs and local provenance manifests remain in the ignored `release/wallpaper-originals` directory. The static review gallery is `release/wallpaper-gallery.html`; it uses only relative local images and contains no JavaScript or network dependencies.

The runtime copies were resized to 1600 pixels wide and encoded with `cwebp` quality 78. This is asset optimization, without additional raster illustration or scene editing. The original generated files remain intact.

## Packaged image sizes

All 21 runtime files were verified as unique WebP images, 1600 pixels wide. Values below are exact bytes.

| Day | Morning | Afternoon | Night |
| --- | ---: | ---: | ---: |
| Monday | 138,622 | 113,126 | 92,668 |
| Tuesday | 144,054 | 201,868 | 119,114 |
| Wednesday | 140,432 | 84,248 | 38,232 |
| Thursday | 209,670 | 154,072 | 61,992 |
| Friday | 115,490 | 146,400 | 68,778 |
| Saturday | 203,554 | 186,930 | 38,358 |
| Sunday | 122,330 | 168,020 | 47,030 |

Total: **2,594,988 bytes** (2.59 MB) for all 21 wallpapers.

Picker thumbnails live in `public/wallpapers/thumbnails/`. They are resized from the same originals with `cwebp -resize 360 0 -q 65`, totaling **202,700 bytes** for all 21 images. These are asset optimizations; the artwork is unchanged.

## Verification

The wallpaper preference update was checked in Chrome and WebKit: nine picker cases, ten scene/schedule cases, and fifteen workspace layout cases passed in each engine. Seventeen adjacent command/dialog checks passed in Chrome. Coverage includes real slider dragging, keyboard endpoints, saved preferences, legacy migration, set rotation, fixed defaults, stale image decodes, accessibility overrides, close cleanup, draft/node identity, and bounded image requests. Calendar tests pause time after startup to avoid crossing a boundary before their initial assertion.

All 22 Node checks and the production build passed, including the 80 KiB compressed startup budget. The lazily loaded picker adds about 4.5 kB compressed JavaScript and CSS when opened. Dark, light, and narrow picker layouts were visually inspected in isolated Chrome contexts with no page errors.
