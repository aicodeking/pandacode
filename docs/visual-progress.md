# Visual progress

While an agent works on a GUI, it can post an annotated screenshot or an SVG idea sketch
for each iteration. The conversation shows them in a picture-in-picture at the top-left of
the conversation pane, one history per thread.

## What you see

- **Collapsed:** a pill (at most 240 px wide) with the latest thumbnails fanned out, the latest title (ellipsized), "6 iterations
  · 7 minutes ago", and a breathing dot while the agent runs. It pulses once when a new
  iteration arrives.
- **Expanded:** a glass card with the current image, its marks with small numbered badges
  and a two-column numbered legend under the image (hover or focus a row, or hover a mark: that
  mark lights, the others recede, and its label shows in a chip kept inside the image), the title (with the live dot), "Iteration 3 of 6"
  and the time, the agent's note, a filmstrip of every iteration on an accent progress rail
  (idea sketches carry a lightbulb), previous/play/next (play shows a progress ring; it
  holds, ring paused, only while the pointer rests on the image), annotations on/off, a before/after slider
  ("Before · 5" / "After · 6"), a large view and Clear history (asks first, then returns
  focus to the composer). The toolbar is one tab stop with arrow keys; the filmstrip steps
  with arrow keys, Home and End. The card never scrolls: the image gives way in a short pane. A portrait image keeps the stage
  at most 240 px tall, with a blurred, dimmed copy of itself in the side bands.
- **Large view:** "Iteration 4 / 6" with the title, the image with the same numbered badges, the
  note and legend beside it (linked to the marks the same way), and previous / filmstrip / next
  below. Arrow keys step; Esc closes. Opened with the pointer, the dialog itself takes focus (no
  ring on the close button); from the keyboard, the close button does. Once closing it takes no
  more input.
- **Esc** is taken only when it closes something: the large view, the clear confirmation or the
  expanded card. Esc on the pill, with nothing to close, still reaches the app (which stops a
  running agent).
- **Staying out of the way** (`src/progress-dim.ts`): it starts collapsed when the pane is
  narrower than 1000 px (until you expand it). The expanded card softens to 55 % while you scroll
  the transcript by hand (wheel, touch, scroll keys; never the app's own stick-to-bottom
  scrolling) or type in the composer, and returns 1.2 s after you stop. Whenever it covers the
  transcript's text column it fades to 14 % (header only) while the pointer is over the
  transcript. While soft, clicks on the card pass
  through to the transcript; only its header takes the pointer, and hovering the header, keyboard
  focus inside, the large view or a new iteration brings it back.
- Drag the header or pill to any corner of the pane; it snaps there. The corner and the
  collapsed state are remembered (`localStorage` `pandacode.progressPip`).
- A new iteration glides in when you are on the latest one; otherwise its thumbnail is
  appended with a quiet "New" badge, and focus and the stage stay where they were.
- `#progress-pip` sits before `#transcript` in the DOM, so it is reached in visual order. A
  thread's PiP fades in over 160 ms; switching threads drops its image caches and observers.
- It shows only in the conversation view for a thread with snapshots. It is hidden on the
  new-task page, the board and the GitHub view, stays above the composer, and takes no
  clicks outside its own bounds.
- Colours come only from theme tokens: info is a slate between text and background, warning
  sits between danger and accent, and labels sit on a dark ink made from the theme's darker end.
  The highlight spotlight dims the rest of the image by 12 % (light) or 18 % (dark) through an
  SVG mask with the highlighted rectangle cut out.

## Motion

Like the live tool trace, this surface choreographs more than the rest of the app, with
`element.animate()` and CSS `@keyframes` (never transitions): the pill-to-card
clip morph, directional crossfades with a little scale and blur, annotation strokes drawing
in with badges popping, the filmstrip cascade (capped at 8), a height glide when the image
shape or note changes, and the lightbox entrance and 200 ms exit. Expand and collapse are
interruptible (they reverse from wherever they are), and dragging freezes any running
animation, then snaps to the corner the PiP is heading for. Easing is `cubic-bezier(.22,1,.36,1)`,
200–460 ms. `prefers-reduced-motion` makes all of it instant; reduced transparency or more
contrast swaps the glass for solid fills.

## Contract

- `progress_list { sessionId }` → `Snapshot[]`:
  `{ id, iteration, title, note?, kind: 'image' | 'idea', annotations, createdAt }`.
  `width`/`height` (px), when present, give the aspect without decoding the image.
- `progress_thumb { sessionId, id }` → a small `data:` URL (≤320 px wide) for the pill and
  filmstrips, loaded as thumbnails scroll into view.
- `progress_media { sessionId, id }` → a `data:image/…` URL, fetched only for the stage, compare
  and large view; the six most recent stay cached (png, jpeg, webp, gif or
  svg+xml). Media is only ever drawn as `<img src="data:…">`; SVG markup never enters the
  DOM, and the app CSP allows no `blob:` images.
- `progress_clear { sessionId }`.
- Event `progress-changed { sessionId }`; the PiP also reloads when the thread's run ends.

Annotations use coordinates from 0 to 1 of the image. `box`, `circle` and `highlight` are
rectangles from `x, y` with `w, h` (a circle is the ellipse inside its rectangle; without
`w, h` it is centred on `x, y`); `highlight` dims everything else. `arrow` runs from `x, y`
to `x2, y2`, head at the end. `pin` is a numbered point. `label` (at most 160 characters,
clamped with the full text in a tooltip) becomes a numbered legend entry and a chip shown
when its mark is in focus; `tone` is `accent` (the theme accent, default), `info`, `success`, `warning`
or `danger`.

## Files

- `src/progress-pip.ts`: the PiP (states, filmstrip, compare, slideshow, drag, live updates).
- `src/progress-lightbox.ts`: the large view.
- `src/progress-marks.ts`: the annotation overlay and legend.
- `src/progress-media.ts`: thumbnail and full-media loading (lazy, LRU).
- `src/progress-motion.ts`: animation helpers (reduced-motion aware).
- `src/progress-dim.ts`: softening while you read, type or point elsewhere.
- `src/progress-pip.css`: styles, keyframes and the token-derived tone colours.
- `src/main.ts`: `syncProgressPip()` mounts it lazily into `#progress-pip` and refreshes it on
  `progress-changed` and run end.
- `src/preview-progress.ts`: preview mocks. Open the browser preview with `?progress` to give
  the first thread six iterations (light, dark, a portrait phone screen and an idea sketch), or
  `?progress=many` for 40.
- `tests/progress-pip.spec.ts`: the browser test.
