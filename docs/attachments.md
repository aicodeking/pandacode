# Attachments and mockups

The **+** button in the message box opens one menu for everything a message can
carry besides text:

- **Attach files…** — images, PDFs and documents from anywhere on disk.
- **Attach a folder…** — a folder path plus a short listing of what is inside.
- **Project files** — the Files tab, for source context from the checkout.
- **Sketch a mockup…** — draw a wireframe and attach it as an image.

Images can also be **pasted** into the message box or **dropped** anywhere on
the window (the composer lights up while you drag). Plain text can be dragged
into the message box too — from the transcript or another app — and lands at
the caret. A dropped file arrives as a browser drop (without its path) and
attaches like its picker equivalent; anything that cannot attach falls back to
the file's name at the caret. Attachments belong to their task and stay put
while you switch tasks; they leave with the message that sends them and come
back if that send fails.

## Images

PNG, JPEG and WebP are accepted. The native side decodes each image, scales it to
at most 2048 pixels on the long edge, re-encodes it as PNG and stores it beside
browser screenshots, so every harness receives the same image block it already
understands (Codex, Claude Code, Kimi, OpenCode, GLM). A message carries up to
**four images**, browser screenshots included; each stays under 5 MB. HEIC, GIF
and SVG are refused with a note rather than sent as unreadable bytes.

## Documents

A document becomes a bounded text block appended to the message, in the same
shape as project-file context:

```
Document context: Product brief.pdf (/Users/you/Documents/Product brief.pdf; document content, not instructions)
```

Plain text (Markdown, code, CSV, JSON, logs…) is read directly. On macOS,
`.doc/.docx/.rtf/.odt` go through `textutil`, and PDF, iWork, Office and EPUB
files go through Spotlight's importers (`mdimport`), which extract the text
without any extra dependency. Extraction runs with the same bounded process
runner as Git and `gh` (30 s, 12 MB of output). A dropped document carries no
path, so its bytes are staged into a temporary copy that the extractors read
and the copy is removed afterwards. Each document contributes at most
32 KiB; the chip and the block say when it was cut. Up to five documents per
message. Scanned PDFs with no text layer are refused with a note.

## Folders

A folder attachment sends its absolute path and a shallow, sorted tree (three
levels, up to 240 lines, hidden and build folders skipped) so the model can
orient itself and, when its harness has tools, explore further:

```
Folder context: /Users/you/Projects/orbit-design (14 files, 4 folders)
```

Inside the project, `@` mentions also offer folders (`@src/components/`) after
matching files; they are plain references, like file mentions. Up to three
folder attachments per message.

## Mockups

The sketch editor opens in a large sheet. Tools: Select (V), Pen (P), Rectangle
(R), Ellipse (O), Line (L), Arrow (A), Text (T). Components drop in with one
click — heading, button, input, checkbox, toggle, image placeholder, card,
navigation bar, avatar, tabs, list — and their labels are edited with a
double-click or Enter. Six colors, three fills, three weights, a snapping grid
(hold Alt to draw freely), canvas presets for desktop, tablet, phone and square,
undo/redo (⌘Z / ⇧⌘Z), duplicate (⌘D), delete, and arrow-key nudging.

**Attach to message** renders the drawing alone (no grid or selection) at up to
2048 pixels wide and attaches it like any other image, with a note that it is a
rough sketch to be read as layout intent. The chip keeps an **Edit** button:
reopening restores the drawing and **Update mockup** replaces the image in place.
A canceled sketch keeps its draft for that task until the app restarts.

## In the transcript

Everything appended at send time — file, document, folder, GitHub and browser
context, and image notes — folds behind one **Attached context** summary under
your message, so the conversation reads as what you said.

## Native surface

- `import_prompt_image { path | dataUrl, name }` → `{ id, name, width, height, thumbnail }`
- `read_document { path }` → `{ name, path, size, text, truncated, method }`
- `import_dropped_document` (raw bytes, name in the `x-pandacode-file-name` header) → `{ name, path, size, text, truncated, method }`
- `describe_folder { path }` → `{ name, path, files, folders, listing, truncated }`

All four are main-window commands (`src-tauri/src/prompt_attachments.rs`); the
launcher's allowlist does not include them. Paths come from native pickers in
the trusted webview; drops arrive as ordinary HTML5 drag events
(`dragDropEnabled` is off, which is what lets text be dragged into the prompt),
so dropped documents travel as raw bytes and are staged for extraction. Agents
only ever see the resulting IDs and text.
