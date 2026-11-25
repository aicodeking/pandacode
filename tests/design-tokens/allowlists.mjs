/**
 * Policy data for the static type/radius guard, shared by CSS and script scans.
 * File keys use repository-relative forward slashes; selector/value exceptions
 * match the normalized spelling the scanners pass, not a browser cascade.
 * Canonical token families and STYLE_PROPS define the accepted CSS/JS vocabulary;
 * Select author rules exempt only files exclusive to runtime windows without the
 * design system, derived by selectImportPolicy from HTML/entry imports (including
 * literal dynamic imports, excluding type-only imports and preview fixtures).
 * CHECKED includes ALLOW_NONE properties, which no stylesheet or tracked style
 * write may set (even to an otherwise harmless keyword).
 *
 * Body medium names a control: CONTROL_EL recognizes button/select/summary/option/a
 * and button/submit/reset inputs; CONTROL_ROLE recognizes button/tab/option/menuitem/
 * switch roles; CONTROL_WORD recognizes button, btn, tab, option, segment, chip,
 * pill or link at word boundaries, with the listed optional control suffixes.
 * The subject of every selector branch must qualify, including :is/:where branches;
 * an ancestor's name alone does not qualify. Prefer a control element, role or class
 * name; extend CONTROLS only for a real control whose existing selector cannot say so,
 * with a reason. Do not change its type role merely to bypass this naming rule.
 *
 * Exception lists are deliberately narrow and must describe real, still-used code:
 * - LITERALS owns fixed logo/device/data shapes outside the UI scale; extend only
 *   for a whole declaration whose geometry or branding cannot use a role token.
 * - EM_SIZES owns the few literal 1em sizes left (Markdown heading 1em resets and row headers);
 *   inline code, h1/h2, citation and KaTeX sizes read the EM_TOKENS instead.
 * - LINE_HEIGHTS owns fixed row/chip line boxes; extend only for a measured layout.
 * - CUSTOM owns misleading type/radius names for other geometry or external APIs;
 *   extend only with the required file/value limits and an actual non-role consumer.
 * - ALIASES gives local type/radius aliases a family; extend only for a justified
 *   indirection that resolves to canonical tokens (or the permitted zero/circle).
 * - ALIAS_VALUES pins those aliases' values and defining files; extend alongside
 *   ALIASES and the visible docs alias table, never to hide arbitrary token drift.
 * - STYLE_EXEMPT owns non-CSS APIs or computed/sanitized writes the scan cannot
 *   prove; extend only after tracing that API and specifying the narrow exemption.
 * - REDEFINES owns intentional canonical overrides outside the owner sheet;
 *   extend only for a documented contextual remap, not another scale definition.
 * - MOCK_CONTENT owns sample product markup rather than app UI; extend only for
 *   preview fixtures, leaving app UI and its style APIs checked.
 * - CONTROLS owns the real controls described above that lack a recognized name.
 * - TRACKING owns deliberate tight-tracking exceptions outside heading roles;
 *   extend only for a documented visual identity such as the wordmark.
 * The entrypoint requires reasons and rejects unused exceptions; ALIAS_VALUES is
 * separately locked to docs, normalizing whitespace and zero versus zero pixels.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../..', import.meta.url));
export const htmlFiles = readdirSync(root).filter(name => name.endsWith('.html')).sort();
export const PHYSICAL_RADIUS = /^(?:-webkit-)?border-(?:top|bottom|before|after)-(?:left|right)-radius$/;
export const RADIUS = /^(?:-webkit-)?(?:border-radius|border-(?:top|bottom|before|after)-(?:left|right)-radius|border-(?:start|end)-(?:start|end)-radius)$/;
export const ALLOW_NONE = new Set(['font-size-adjust', '-webkit-text-size-adjust', 'font-variant-caps']);
export const CHECKED = new Set(['font-size', 'font-weight', 'line-height', 'letter-spacing', 'font-family', 'font', ...ALLOW_NONE]);
export const NAME_HINT = /size|radius|weight|leading|font|line-height|tracking/i;
export const ROLES = 'display|title|heading|subheading|body|prose|meta|caption';
export const LEADING_ROLES = new Set(['display', 'title', 'heading']);
export const TRACKING_ROLES = new Set(['display', 'title', 'heading']);
/**
 * Canonical em sizes, defined only in src/tokens.css (values are read from there and
 * locked to docs/agent-reference.md, never repeated here): app-wide inline code, then
 * the Markdown-only h1/h2, citation and KaTeX sizes. Every other em-name list derives from this one.
 */
export const EM_TOKENS = ['--code-inline-size', '--md-heading-lg', '--md-cite-size', '--md-katex-size'];
const EM_TOKEN_ALTS = EM_TOKENS.map(name => name.slice(2)).join('|');
export const EM_TOKEN_NAME = new RegExp(`^--(?:${EM_TOKEN_ALTS})$`);
export const FONT_SIZE_NAME = new RegExp(`^--(?:type-(?:${ROLES})|mono-size|thread-font|root-size|${EM_TOKEN_ALTS})$`);
export const WEIGHT_NAME = new RegExp(`^--(?:weight-[\\w-]+|type-(?:${ROLES})-weight)$`);
export const LEADING_NAME = new RegExp(`^--(?:type-(?:${ROLES})-leading|type-prose-compact-leading|leading-[\\w-]+|(?:row|control)(?:-[\\w-]+)?|ds-row-h(?:-sub)?|ds-btn(?:-primary)?-h)$`);
export const RADIUS_NAME = /^--radius-[\w-]+$/;
export const TRACKING_NAME = /^--tracking-[\w-]+$/;
export const FAMILY_NAME = /^--(?:sans|mono)$/;
export const DEPRECATED = /--(?:ds-text-(?:title|lead|row-lg|body|head|check|sub|ui|meta|chip)|ds-radius-(?:card|inner|control|chip)|text-(?:2xs|xs|sm|md|lg|xl)|radius-(?:xs|sm|md|lg)|leading-(?:tight|ui|body))\b/;
export const ROOT_FILES = new Set(['src/overlay.css', 'src/tray-popover.css', ...htmlFiles]);
export const STYLE_PROPS = {
  fontSize: 'font-size',
  fontSizeAdjust: 'font-size-adjust',
  webkitTextSizeAdjust: '-webkit-text-size-adjust',
  fontVariantCaps: 'font-variant-caps',
  fontWeight: 'font-weight',
  lineHeight: 'line-height',
  letterSpacing: 'letter-spacing',
  borderRadius: 'border-radius',
  font: 'font',
  fontFamily: 'font-family',
  borderTopLeftRadius: 'border-top-left-radius',
  borderTopRightRadius: 'border-top-right-radius',
  borderBottomLeftRadius: 'border-bottom-left-radius',
  borderBottomRightRadius: 'border-bottom-right-radius',
  borderStartStartRadius: 'border-start-start-radius',
  borderStartEndRadius: 'border-start-end-radius',
  borderEndStartRadius: 'border-end-start-radius',
  borderEndEndRadius: 'border-end-end-radius',
  webkitBorderRadius: '-webkit-border-radius',
  webkitBorderTopLeftRadius: '-webkit-border-top-left-radius',
  webkitBorderTopRightRadius: '-webkit-border-top-right-radius',
  webkitBorderBottomLeftRadius: '-webkit-border-bottom-left-radius',
  webkitBorderBottomRightRadius: '-webkit-border-bottom-right-radius',
  webkitBorderBeforeLeftRadius: '-webkit-border-before-left-radius',
  webkitBorderBeforeRightRadius: '-webkit-border-before-right-radius',
  webkitBorderAfterLeftRadius: '-webkit-border-after-left-radius',
  webkitBorderAfterRightRadius: '-webkit-border-after-right-radius',
  clipPath: 'clip-path',
  webkitClipPath: '-webkit-clip-path',
  zoom: 'zoom',
  fontVariationSettings: 'font-variation-settings',
  fontVariant: 'font-variant',
  fontStretch: 'font-stretch',
  fontWidth: 'font-width',
  fontFeatureSettings: 'font-feature-settings',
  webkitFontFeatureSettings: '-webkit-font-feature-settings',
  all: 'all',
};
export const STYLE_KEYS = Object.keys(STYLE_PROPS).join('|');
export const ROW_LEADING = /^--(?:(?:row|control)(?:-[\w-]+)?|ds-row-h(?:-sub)?|ds-btn(?:-primary)?-h)$/;
export const SOFT_ROLES = new Set(['subheading', 'body', 'prose', 'meta', 'caption']);
export const CONTROL_EL = /^(?:(?:button|select|summary|option|a)(?![-\w\\])|input(?![-\w\\])(?=(?:[^[]|\[(?:[^\]"']|"[^"]*"|'[^']*')*\])*\[type\s*=\s*["']?(?:button|submit|reset)["']?(?:\s+[is])?\s*\]))/i;
export const CONTROL_ROLE = /\[role\s*=\s*["']?(?:button|tab|option|menuitem|switch)/i;
export const CONTROL_WORD = /(?:^|[^a-z0-9\\])(?:button|btn|tab|option|segment|chip|pill|link)(?:-(?:primary|secondary|ghost|quiet|danger|icon|sm|lg))?(?![-\w\\])/i;

/** Whole declarations the scale does not own. */
export const LITERALS = [
  {
    file: 'src/brand-mark.css',
    selector: '.desktop-brand-word',
    property: 'font-size',
    value: '20px',
    reason: 'Brand wordmark is a fixed logo size, not a type role.',
  },
  {
    file: 'src/trace-brands.ts',
    selector: '(svg text)',
    property: 'font-size',
    value: '10.5',
    reason: 'Brand letter tiles draw the letter in the 16-unit icon viewBox, so it scales with the mark and is not a type role.',
  },
  {
    file: 'src/trace-brands.ts',
    selector: '(svg text)',
    property: 'font-weight',
    value: '700',
    reason: 'The brand letter tile is part of the 16-unit icon drawing; its bold glyph is artwork, not a UI weight role.',
  },
  {
    file: 'src/trace-brands.ts',
    selector: '(svg text)',
    property: 'font-family',
    value: 'system-ui,sans-serif',
    reason: 'The brand letter tile glyph is part of the 16-unit icon drawing, which page tokens inside the SVG attribute cannot reach.',
  },
  {
    file: 'src/simulator.css',
    selector: '.sim-flat',
    property: 'border-radius',
    value: '28px',
    reason: 'Simulator device bezel is the phone shape, not a radius step.',
  },
  {
    file: 'src/usage-heatmap.css',
    selector: '.heatmap-cell',
    property: 'border-radius',
    value: 'calc(var(--cell,4px) * .28)',
    reason: 'Heatmap cell radius scales with the cell, so it is not a radius step.',
  },
  {
    file: 'src/brand-mark.css',
    selector: '.desktop-brand-word',
    property: 'font-family',
    value: 'ui-rounded,"SF Pro Rounded","Arial Rounded MT Bold",system-ui,sans-serif',
    reason: 'Brand wordmark uses the rounded logo stack, not the UI sans.',
  },
];

/** Non-zero em font-sizes. Markdown and code only, relative to the surrounding text. */
export const EM_SIZES = [
  { file: 'src/styles.css', selector: '.markdown h1,.markdown h2,.markdown h3,.markdown h4,.markdown h5,.markdown h6', value: '1em', reason: 'Markdown headings stay em-relative to the thread font.' },
  { file: 'src/overlay.css', selector: '.launcher-thread-message :is(h1,h2,h3,h4,h5,h6)', value: '1em', reason: 'Launcher Markdown headings stay em-relative to the message prose, matching the conversation.' },
  { file: 'src/shadow-base.css', selector: ':where(h3,h4,h5,h6)', value: '1em', reason: 'Bare Shadow DOM h3-h6 stay at the surrounding prose size (strong 600), matching Markdown minor headings.' },
  { file: 'src/shadow-base.css', selector: ':where(tbody th:not([scope="col" i],[scope="colgroup" i]),th:is([scope="row" i],[scope="rowgroup" i]))', value: '1em', reason: 'Bare Shadow DOM row headers are prose cells at the surrounding size, matching Markdown row headers.' },
  { file: 'src/type-base.css', selector: '.markdown :is(tbody th:not([scope="col" i],[scope="colgroup" i]),th:is([scope="row" i],[scope="rowgroup" i]))', value: '1em', reason: 'Markdown row headers are prose cells, so they keep the surrounding --thread-font size (main thread, document reader, launcher and side threads).' },
];

/** px line-heights on a fixed chip, badge or single-line row. */
export const LINE_HEIGHTS = [
  { file: 'src/brand-mark.css', selector: '.desktop-brand-word', value: '24px', reason: 'Wordmark line box is the logo height, paired with the 20px mark.' },
  { file: 'src/tool-trace.css', selector: '.is-steps .tool-trace-image>.tool-image-name', value: 'calc(var(--row-sm) - 2px)', reason: 'Image-name chip fills the row minus its border.' },
  { file: 'src/changes-view.ts', selector: "pre[data-diff] [data-separator='metadata'] [data-separator-wrapper]", value: 'calc(var(--mono-size) * 5 / 3)', reason: 'Hunk metadata row is 20px tall. Mono size times 5/3 is that height, so the line box fills the row.' },
];

/** Custom properties whose names look like type or radius but are not a role. */
export const CUSTOM = [
  { name: '--icon-size', allowLiteral: true, reason: 'Icon box length. It sizes the SVG, not a type or radius role.' },
  {
    name: '--diff-line-height',
    files: new Set(['src/diff-viewer.css', 'src/changes-view.css']),
    values: new Set(['calc(var(--mono-size)*1.6)']),
    allowLiteral: true,
    reason: 'The diff viewer reads a length, mono size times 1.6, as the row height of a line that has not mounted yet.',
  },
  {
    name: '--diffs-line-height',
    files: new Set(['src/diff-viewer.css', 'src/changes-view.css', 'src/diff-viewer.ts']),
    values: new Set(['calc(var(--mono-size)*1.6)', 'var(--diff-row-pitch)']),
    allowLiteral: true,
    reason: 'The diffs element reads that same row length.',
  },
  {
    name: '--diffs-font-size',
    files: new Set(['src/diff-viewer.css', 'src/changes-view.css', 'src/diff-viewer.ts']),
    values: new Set(['var(--mono-size)']),
    reason: 'The diffs web component reads --diffs-font-size inside its shadow DOM.',
  },
  {
    name: '--diffs-font-family',
    files: new Set(['src/diff-viewer.css', 'src/diff-viewer.ts']),
    values: new Set(['var(--mono)']),
    reason: 'The diffs web component reads --diffs-font-family inside its shadow DOM.',
  },
];

/** Style APIs that are not CSS type or radius. Each entry must match real code. */
export const STYLE_EXEMPT = [
  { file: 'src/terminal.ts', api: 'xterm', reason: 'xterm.js fontSize is a numeric CSS-pixel option, not the CSS font-size property.' },
  { file: 'src/sketch.ts', api: 'sketch', reason: 'Sketch text is a drawn shape. Its pixel fontSize is copied onto the textarea, not a UI type role.' },
  { file: 'src/sketch.ts', api: 'canvas-font', receivers: ['context'], reason: 'The freehand mockup canvas draws text shapes at their own pixel size and weight; that drawing is artwork, not UI type.' },
  { file: 'src/simulator-3d.ts', api: 'canvas-font', receivers: ['paint'], reason: 'The 3D device screen texture paints its label in texture pixels sized to the canvas; page type tokens cannot reach a WebGL texture.' },
  { file: 'src/motion.ts', api: 'computed-radius', reason: 'The dialog exit ghost copies the plate radius already computed from the token.' },
  { file: 'src/token-saver-panel.ts', api: 'setAttribute-style', reason: 'Restores the segmented track inline style saved before morph() so the thumb slides from its prior offset.' },
  { file: 'src/generative-ui-components.ts', api: 'setAttribute-style', reason: 'DOMPurify sanitizer rewrites a sanitized custom-view element style attribute through scrubCss().' },
  { file: 'src/tray-popover.ts', api: 'dynamic-setProperty', reason: 'Applies the computed palette accent tokens onto the tray popover root.' },
  { file: 'src/motion.ts', api: 'dynamic-setProperty', reason: 'Publishes computed spring easing and duration custom properties onto the root.' },
  { file: 'src/palette.ts', api: 'dynamic-setProperty', reason: 'Writes the computed palette token map onto the document root.' },
  { file: 'src/overlay.ts', api: 'dynamic-setProperty', reason: 'Applies the computed palette accent tokens onto the launcher overlay root.' },
  { file: 'src/brand-mark.ts', api: 'dynamic-setProperty', reason: 'Caches per-frame transform and --brand-wipe style writes on the animated desktop panda.' },
  { file: 'src/bot-avatars.ts', api: 'dynamic-html-style', reason: 'Avatar and color pickers interpolate swatch background and --panda-bg color fragments into inline style attributes.' },
  { file: 'src/progress-marks.ts', api: 'dynamic-html-style', reason: 'Progress-snapshot annotation marks interpolate the --i stagger order variable into inline style attributes.' },
];

/**
 * Local aliases used in type or radius properties. Each definition must be a
 * canonical token (or the allowed zero). --mono-size is itself in tokens.css.
 */
export const ALIASES = [
  { name: '--ds-card-radius', family: 'radius', reason: 'Cards use the card scale, stepped to inner in modal dialogs.' },
  { name: '--ds-inner-radius', family: 'radius', reason: 'Inset cards and tracks use the inner scale, stepped to control in modal dialogs.' },
  { name: '--ds-control-radius', family: 'radius', reason: 'Controls, rows and fields use the control scale, stepped to chip in modal dialogs.' },
  { name: '--inset-radius', family: 'radius', reason: 'Inset panels use the card radius. The narrow rail sets 0.' },
  { name: '--gu-surface-radius', family: 'radius', reason: 'Generative UI surfaces use inner radius at outer level, control radius inside nested cards and turn-card replies, chip radius inside tight hosts, and hair radius inside nested tight hosts.' },
  { name: '--code-copy-radius', family: 'radius', reason: 'Code-block copy buttons use chip radius in standard blocks and step down to hair radius inside tight or nested surfaces.' },
  { name: '--thread-font', family: 'font-size', reason: 'Transcript text is the prose role. A side thread and the compact GitHub job summary use the meta role.' },
];

export const ALIAS_VALUES = new Map([
  ['--ds-card-radius', { values: new Set(['var(--radius-card)', 'var(--radius-inner)']), files: new Set(['src/tokens.css']) }],
  ['--ds-inner-radius', { values: new Set(['var(--radius-inner)', 'var(--radius-control)']), files: new Set(['src/tokens.css']) }],
  ['--ds-control-radius', { values: new Set(['var(--radius-control)', 'var(--radius-chip)']), files: new Set(['src/tokens.css']) }],
  ['--thread-font', { values: new Set(['var(--type-prose)', 'var(--type-meta)']), files: new Set(['src/styles.css', 'src/overlay.css', 'src/task-board.css', 'src/tray-popover.css', 'src/github-hub.css']) }],
  ['--inset-radius', { values: new Set(['var(--ds-card-radius)', '0', '0px']), files: new Set(['src/inset-shell.css']) }],
  ['--gu-surface-radius', { values: new Set(['var(--ds-inner-radius)', 'var(--ds-control-radius)', 'var(--radius-chip)', 'var(--radius-hair)']), files: new Set(['src/generative-ui.css', 'src/turn-card.css']) }],
  ['--code-copy-radius', { values: new Set(['var(--radius-chip)', 'var(--radius-hair)']), files: new Set(['src/generative-ui.css', 'src/github-hub.css', 'src/agent-input.css', 'src/styles.css', 'src/overlay.css', 'src/turn-card.css', 'src/bot-shared-channels.css']) }],
]);

/** letter-spacing:var(--tracking-tight) on a rule that is not display, title or heading. */
export const TRACKING = [
  { file: 'src/brand-mark.css', selector: '.desktop-brand-word', reason: 'The wordmark is a fixed logo, not a display, title or heading role.' },
];

export const aliasNames = new Set(ALIASES.map(item => item.name));

/** Definitions of a canonical token outside its owning stylesheet. Each entry must match real code. */
export const REDEFINES = [
  { file: 'src/overlay.css', name: '--info', reason: 'The launcher window remaps status info onto its own palette.' },
  { file: 'src/overlay.css', name: '--warning', reason: 'The launcher window remaps status warning onto its own palette.' },
  { file: 'src/overlay-model-picker.css', name: '--surface-1', reason: 'The launcher model picker remaps surfaces onto the launcher palette.' },
  { file: 'src/overlay-model-picker.css', name: '--surface-2', reason: 'The launcher model picker remaps surfaces onto the launcher palette.' },
  { file: 'src/overlay-model-picker.css', name: '--fill-hover', reason: 'The launcher model picker remaps fills onto the launcher palette.' },
  { file: 'src/overlay-model-picker.css', name: '--fill-active', reason: 'The launcher model picker remaps fills onto the launcher palette.' },
  { file: 'src/overlay-model-picker.css', name: '--fill-selected', reason: 'The launcher model picker remaps fills onto the launcher palette.' },
];

/** Sample product HTML in the design-canvas preview, not app UI. */
export const MOCK_CONTENT = [
  { file: 'src/preview-design.ts', reason: 'Artboard HTML (44px hero, 16px and 15px page fonts, 8px button) is sample product markup, not app UI.' },
];

/**
 * Markdown parity treats any unknown outer class as a possible Markdown ancestor. These
 * component rules style the component's own heading, label or code block, which sits beside
 * (never around) a Markdown root, so parity skips them. Extend only after checking the
 * component's markup; an entry whose rule no longer reaches a Markdown sample path fails.
 */
const OWN = 'styles its own label, not Markdown it never wraps';
/** Kinds of component rules in main-document sheets that never name a Markdown root (found by the import-order walk). */
const HEADING = `Panel or section title ${OWN}`;
const COPY = 'Component copy paragraph; the component renders no Markdown.';
const ROWS = 'Component list row (steps, timeline, findings), not a Markdown list.';
const WRAPPER = 'Component-built list or table that sizes its own rows; never a Markdown ul/ol/table wrapper.';
const LABEL = `Component label ${OWN}`;
const CHROME = 'Component chrome (link, term, cell or note) outside rendered Markdown.';
const CHIP = 'Standalone code chip (path, command or pairing code) that keeps the mono size; not Markdown inline code.';
const DESC_CODE = 'Code in a component description, never inside a pre; only the pre code sample reaches it.';
const outside = (file, reason, selectors) => selectors.map(selector => ({ file, selector, reason }));
export const MARKDOWN_OUTSIDE = [
  { file: 'src/agent-input.css', selector: '.agent-input h3', reason: 'The request title h3; option and legend Markdown is inline-only.' },
  { file: 'src/architect.css', selector: '.architect-section-label h3', reason: `Section label h3 ${OWN}.` },
  { file: 'src/architect.css', selector: '.architect-worker-meta strong', reason: `Worker name ${OWN}.` },
  { file: 'src/architect.css', selector: '.architect-worker-meta .architect-worker-copy strong', reason: `Worker name ${OWN}.` },
  { file: 'src/architect.css', selector: '.architect-worker-row .architect-worker-copy strong', reason: `Worker name ${OWN}.` },
  { file: 'src/architect.css', selector: '.architect-setup-heading h2', reason: `Setup title ${OWN}.` },
  { file: 'src/generative-ui.css', selector: '.gu-code pre', reason: 'The code view pre is highlighted source, not Markdown.' },
  { file: 'src/generative-ui.css', selector: '.gu-failed pre', reason: 'The failed-render pre shows raw source, not Markdown.' },
  ...outside('src/generative-ui.css', WRAPPER, ['.gu-checklist ul', '.gu-tree ul', '.gu-compare ul', '.gu-table table']),
  { file: 'src/github-hub.css', selector: '.gh-empty b', reason: `Empty-state title ${OWN}.` },
  { file: 'src/github-hub.css', selector: '.gh-title h2', reason: `Hub title ${OWN}.` },
  { file: 'src/github-hub.css', selector: '.gh-repo-name b', reason: `Repository name ${OWN}.` },
  { file: 'src/overlay.css', selector: '.launcher-thread-activity .tool-activity-body h4', reason: 'Tool activity section heading beside the reply, not inside its Markdown.' },
  { file: 'src/overlay.css', selector: '.launcher-task strong', reason: `Launcher task title ${OWN}.` },
  { file: 'src/overlay.css', selector: '.launcher-thread-activity .tool-trace-kv th', reason: 'Tool activity key/value header beside the reply, not inside its Markdown.' },
  { file: 'src/styles.css', selector: '.bot-crumb strong', reason: `Breadcrumb name ${OWN}.` },
  { file: 'src/styles.css', selector: '.change-file strong', reason: `Changed-file name ${OWN}.` },
  { file: 'src/styles.css', selector: '.command-dialog .dialog-heading h2', reason: `Dialog title ${OWN}.` },
  { file: 'src/styles.css', selector: '.dialog-heading h2', reason: `Dialog title ${OWN}.` },
  { file: 'src/styles.css', selector: '.empty-conversation h2', reason: `Empty-conversation title ${OWN}.` },
  { file: 'src/styles.css', selector: '.inspector-empty h3', reason: `Empty-state title ${OWN}.` },
  { file: 'src/styles.css', selector: '.metrics-list strong', reason: `Metric value ${OWN}.` },
  { file: 'src/styles.css', selector: '.provider-diagnostic-heading strong', reason: `Diagnostic heading ${OWN}.` },
  { file: 'src/styles.css', selector: '.setting-row strong', reason: `Setting label ${OWN}.` },
  { file: 'src/styles.css', selector: '.tool-activity-section h4', reason: `Tool activity section heading ${OWN}.` },
  { file: 'src/styles.css', selector: '.new-task-welcome h1', reason: `Welcome title ${OWN}.` },
  { file: 'src/styles.css', selector: '.trace-brand-chip b', reason: `Trace brand chip ${OWN}.` },
  { file: 'src/styles.css', selector: '.welcome h1', reason: `Welcome title ${OWN}.` },
  { file: 'src/subagents.css', selector: '.subagent-row-copy strong', reason: `Subagent name ${OWN}.` },
  ...outside('src/agent-teams.css', HEADING, ['.agent-team-models h4']),
  ...outside('src/agent-teams.css', LABEL, ['.agent-team-name strong']),
  ...outside('src/agent-usage.css', CHROME, ['.usage-totals dd', '.usage-breakdown td', '.usage-breakdown th,.usage-breakdown td']),
  ...outside('src/agent-usage.css', COPY, ['.usage-notice p']),
  ...outside('src/agent-usage.css', DESC_CODE, ['.usage-notice .usage-fix-hint code']),
  ...outside('src/agent-usage.css', HEADING, ['.usage-section h3', '.usage-card-heading h3', '.usage-account-title h4']),
  ...outside('src/agent-usage.css', LABEL, ['.usage-agent-copy strong', '.cost-chart-value strong', '.usage-window-heading strong']),
  ...outside('src/agents-dock.css', LABEL, ['.agents-dock-head strong', '.agents-dock-window-head strong']),
  ...outside('src/approval-bar.css', LABEL, ['.approval-group .approval-summary strong']),
  ...outside('src/bots-settings.css', COPY, ['.bs-panel-head p']),
  ...outside('src/bots-settings.css', HEADING, ['.bs-panel-head h2', '.bots-detail .bots-panel h4', '.bp-avatar-pop h5']),
  ...outside('src/bots-settings.css', LABEL, ['.bs-row-text strong', '.bp-rule-options strong']),
  ...outside('src/bots-settings.css', ROWS, ['.bp-backups li']),
  ...outside('src/bots.css', CHROME, ['.bots-kind-grid em']),
  ...outside('src/bots.css', COPY, ['.bots-title p', '.bots-confirm p', '.bots-steps p', '.bot-failover p']),
  ...outside('src/bots.css', HEADING, ['.bots-title h3', '.bots-form h3', '.bots-panel h4', '.bc-suggestions h4']),
  ...outside('src/bots.css', LABEL, ['.bots-row-text b', '.bots-stats b', '.bots-kind-grid b', '.bots-steps b', '.bots-steps p b', '.bots-guide b', '.bc-card b']),
  ...outside('src/browser.css', COPY, ['.browser-sample p']),
  ...outside('src/browser.css', HEADING, ['.browser-home h2', '.browser-sample h2']),
  ...outside('src/browser.css', LABEL, ['.browser-server strong', '.browser-context-chip strong']),
  ...outside('src/btw.css', LABEL, ['.btw-head strong']),
  ...outside('src/capabilities-panel.css', HEADING, ['.capabilities-section h3']),
  ...outside('src/capabilities-panel.css', LABEL, ['.capabilities-panel-head strong']),
  ...outside('src/command-center.css', HEADING, ['.command-center-heading h2']),
  ...outside('src/command-center.css', LABEL, ['.goal-overview strong', '.goal-banner-copy strong', '.command-row strong', '.command-row-copy strong']),
  ...outside('src/conversation-import.css', LABEL, ['.import-copy strong']),
  ...outside('src/council.css', COPY, ['.council-panel p']),
  ...outside('src/design-system.css', HEADING, ['.dialog-heading h2']),
  ...outside('src/file-mentions.css', LABEL, ['.file-mention-option strong,.file-mention-option small', '.file-mention-option strong', '.file-mention-folder strong']),
  ...outside('src/github-hub.css', COPY, ['.gh-empty p']),
  ...outside('src/github-pull.css', LABEL, ['.pull-author strong', '.pull-comment-meta strong']),
  ...outside('src/github.css', DESC_CODE, ['.github-pr-dialog .dialog-description code']),
  ...outside('src/github.css', LABEL, ['.github-issue-copy strong']),
  ...outside('src/integrations.css', LABEL, ['.integration-row strong']),
  ...outside('src/jev-assist.css', COPY, ['.jev-assist-recommendation p']),
  ...outside('src/jev-assist.css', HEADING, ['.jev-assist-history-heading h3', '.jev-assist-report h4', '.jev-assist-matches h4']),
  ...outside('src/jev-assist.css', LABEL, ['.jev-assist-evidence-heading strong', '.jev-assist-recommendation strong']),
  ...outside('src/jev-assist.css', ROWS, ['.jev-assist-findings li']),
  ...outside('src/jev-live.css', ROWS, ['.jev-live-timeline li']),
  ...outside('src/jev.css', HEADING, ['.jev-heading h2', '.jev-popover .jev-heading h2', '.jev-section-heading h3', '.jev-popover .jev-section-heading h3']),
  ...outside('src/jev.css', LABEL, ['.jev-enable-row strong', '.jev-events strong']),
  ...outside('src/jev.css', ROWS, ['.jev-events li']),
  ...outside('src/jev.css', WRAPPER, ['.jev-doctor-details ul', '.jev-verification ul']),
  ...outside('src/machine-orchestration.css', LABEL, ['.machine-link-text strong', '.lineage-wait strong', '.machine-threads-copy strong']),
  ...outside('src/machine-orchestration.css', ROWS, ['.machine-steps li']),
  ...outside('src/message-queue.css', LABEL, ['.queue-heading strong', '.queue-confirm strong']),
  ...outside('src/moodboards.css', COPY, ['.moodboard-empty p', '.moodboard-lightbox p']),
  ...outside('src/moodboards.css', HEADING, ['.moodboard-empty h3']),
  ...outside('src/motion.css', HEADING, ['.dialog-heading h2']),
  ...outside('src/opencode-model-settings.css', LABEL, ['.opencode-model-copy strong']),
  ...outside('src/overlay.css', COPY, ['.launcher-thread-heading p']),
  ...outside('src/progress-pip.css', LABEL, ['.pp-pill-text strong', '.pp-lb-count strong']),
  ...outside('src/provider-settings.css', CHROME, ['.connection-card a']),
  ...outside('src/provider-settings.css', COPY, ['.connection-card p']),
  ...outside('src/recipes.css', CHROME, ['.recipe-steps th']),
  ...outside('src/recipes.css', HEADING, ['.recipe-detail h3']),
  ...outside('src/redesign/bots.css', COPY, ['html[data-theme] .bots-panel-start p']),
  ...outside('src/redesign/bots.css', HEADING, ['html[data-theme] .bs-panel-head h2']),
  ...outside('src/redesign/bots.css', LABEL, ['html[data-theme] .bot-crumb strong', 'html[data-theme] .bots-row-text b']),
  ...outside('src/redesign/conversation.css', HEADING, ['.conversation-pane .agent-input h3']),
  ...outside('src/redesign/conversation.css', LABEL, ['.conversation-pane .composer-tray .composer-saver-button b']),
  ...outside('src/redesign/inspector.css', LABEL, ['#inspector .vm-empty strong']),
  ...outside('src/redesign/settings.css', LABEL, ['html[data-theme] .diag-actions-text strong', 'html[data-theme] .diag-event b']),
  ...outside('src/remote-diagnostics.css', CHROME, ['.diag-routes th']),
  ...outside('src/remote-diagnostics.css', HEADING, ['.remote-diagnostics h4']),
  ...outside('src/remote-diagnostics.css', LABEL, ['.diag-event b']),
  ...outside('src/remote-pairing-prompt.css', CHIP, ['.pairing-prompt code']),
  ...outside('src/remote-pairing-prompt.css', LABEL, ['.pairing-prompt-text strong']),
  ...outside('src/schedules-settings.css', COPY, ['.schedules-empty p']),
  ...outside('src/schedules-settings.css', HEADING, ['.schedules-group h4']),
  ...outside('src/schedules-settings.css', LABEL, ['.schedule-main strong', '.schedule-flow-head .schedule-main strong', '.schedule-run-text strong']),
  ...outside('src/schedules.css', HEADING, ['.wake-history h4']),
  ...outside('src/schedules.css', LABEL, ['.wake-summary:has(strong) strong', '.wake-summary strong', '.scheduled-mark strong']),
  ...outside('src/settings.css', CHROME, ['.harness-privacy-list em']),
  ...outside('src/settings.css', COPY, ['.support-details p']),
  ...outside('src/settings.css', HEADING, ['.settings-panel-head h2', '.settings-heading h3', '.settings-agents-heading h3']),
  ...outside('src/settings.css', LABEL, ['.settings-page-root .setting-row strong']),
  ...outside('src/simulator.css', LABEL, ['.sim-axe strong']),
  ...outside('src/skills-library.css', CHIP, ['.skills-findings code,.skills-unmanaged code']),
  ...outside('src/skills-library.css', LABEL, ['.skills-item-head strong', '.skills-unmanaged strong']),
  ...outside('src/slash-commands.css', LABEL, ['.slash-menu-header strong', '.slash-menu-title strong']),
  ...outside('src/styles.css', COPY, ['.inspector-empty p', '.welcome p', '.empty-conversation p']),
  ...outside('src/task-board.css', HEADING, ['.board-heading h1', '.task-detail-summary h1', '.board-column h2']),
  ...outside('src/task-board.css', LABEL, ['.board-card-open strong']),
  ...outside('src/team-messages.css', LABEL, ['.team-message-heading strong']),
  ...outside('src/team-progress.css', LABEL, ['.team-progress-description strong']),
  ...outside('src/theme-settings.css', HEADING, ['.colors-section h3']),
  ...outside('src/theme-settings.css', LABEL, ['.vsix-name strong']),
  ...outside('src/token-saver.css', LABEL, ['.saver-head strong', '.composer-saver-button b']),
  ...outside('src/tool-cards.css', LABEL, ['.tc b', '.tc-title-card b']),
  ...outside('src/tool-trace.css', CHIP, ['.tool-trace-files code']),
  ...outside('src/tool-trace.css', LABEL, ['.tool-trace-chip b', '.tool-trace-bubble-head b', '.is-steps .tool-trace-chip b', '.trace-row-head b']),
  ...outside('src/usage-heatmap.css', HEADING, ['.heatmap-heading h3']),
  ...outside('src/usage-heatmap.css', LABEL, ['.heatmap-readout strong']),
  ...outside('src/vm-panel.css', LABEL, ['.vm-empty strong']),
  ...outside('src/voice-settings.css', HEADING, ['.voice-editor-head h4']),
  ...outside('src/voice-settings.css', LABEL, ['.voice-model-facts strong']),
  ...outside('src/wallpaper-settings.css', HEADING, ['.wallpaper-section-heading h3']),
  ...outside('src/wallpaper-settings.css', LABEL, ['.wallpaper-preview-composer b']),
  ...outside('src/web-bridge.css', HEADING, ['.web-modal-card h2']),
  ...outside('src/worktrees.css', DESC_CODE, ['.worktree-preview code,.worktree-cleanup-option code,.worktree-dialog .dialog-description code']),
];

/**
 * `--type-body` with `--weight-medium` on a control whose class does not say
 * button, chip, tab, link or the other control words.
 */
export const CONTROLS = [
  { file: 'src/architect.css', selector: '.architect-assist', reason: 'Assist is a 24px button.' },
  { file: 'src/github-hub.css', selector: '.gh-clone', reason: 'Clone is a primary button.' },
  { file: 'src/github-hub.css', selector: '.gh-act', reason: 'A run action is a button.' },
  { file: 'src/message-queue.css', selector: '.queue-resume', reason: 'Resume is a button.' },
  { file: 'src/schedules-settings.css', selector: '.schedules-template', reason: 'A schedule template is a button.' },
  { file: 'src/settings.css', selector: '.settings-back', reason: 'Back is a button.' },
  { file: 'src/sidebar-bots.css', selector: '.sidebar-bots-bar', reason: 'The bots bar is a button.' },
  { file: 'src/sketch.css', selector: '.sketch-text-editor', reason: 'The sketch text editor is a textarea.' },
  { file: 'src/styles.css', selector: '.breadcrumb>.bot-crumb-settings', reason: 'The crumb settings control is a button.' },
  { file: 'src/styles.css', selector: '.bot-jump', reason: 'Jump is a button.' },
  { file: 'src/styles.css', selector: '.queue-now', reason: 'Send now is a button.' },
  { file: 'src/styles.css', selector: '.remote-note-action', reason: 'The remote note action is a text button.' },
  { file: 'src/task-board.css', selector: '.board-card-start', reason: 'Start is a button on the card.' },
  { file: 'src/turn-card.css', selector: '.turn-card-more', reason: 'Read more is a button.' },
  { file: 'src/turn-changes.css', selector: '.turn-changes-open,.turn-changes-run', reason: 'Open and Run are buttons.' },
  { file: 'src/usage-limit.css', selector: '.limit-continue', reason: 'Continue is a button.' },
  { file: 'src/machine-orchestration.css', selector: ':is(.machine-quiet,.machine-primary)', reason: 'Quiet and primary are 24px buttons.' },
  { file: 'src/token-saver.css', selector: '.saver-tighten', reason: 'Tighten is a text button.' },
  { file: 'src/redesign/conversation.css', selector: '.conversation-pane .composer-tray :is(.model-picker,.mode-picker,.composer-team-button,.composer-saver-button,.composer-council-button)', reason: 'Model and mode pickers are composer-tray buttons alongside the other tray buttons.' },
  { file: 'src/redesign/conversation.css', selector: '.composer-tray .composer-context>:is(.composer-computer,.composer-local,.branch-chip,.link-chip)', reason: 'Composer computer and local triggers are composer-tray buttons alongside the branch and link chips.' },
];


/** Every script extension the src/ guards walk (shared by gu-containers, flow, segmented and ts-style-canvas). */
export const SCRIPT_EXTS = Object.freeze(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);

let selectPolicy;
/** Derive sheets/scripts exclusive to runtime windows that never import design-system.css. */
export function selectImportPolicy() {
  if (selectPolicy) return selectPolicy;
  const imports = new Map();
  const resolveImport = (from, spec) => {
    if (!spec.startsWith('.')) return '';
    const base = resolve(root, dirname(from), spec.split('?')[0]);
    for (const path of [base, ...['.ts', '.tsx', '.js', '.mjs'].map(ext => base + ext), join(base, 'index.ts')]) {
      try { if (statSync(path).isFile()) return relative(root, path).replaceAll('\\', '/'); } catch {}
    }
    return '';
  };
  const dependencies = file => {
    if (imports.has(file)) return imports.get(file);
    const source = readFileSync(join(root, file), 'utf8');
    const specs = [];
    if (file.endsWith('.css')) {
      for (const match of source.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]/g)) specs.push(match[1]);
    } else {
      const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
      const visit = node => {
        if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text);
        if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text);
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) specs.push(node.arguments[0].text);
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    const files = specs.map(spec => resolveImport(file, spec)).filter(Boolean);
    imports.set(file, files);
    return files;
  };
  const entries = new Set();
  for (const html of htmlFiles) {
    for (const match of readFileSync(join(root, html), 'utf8').matchAll(/<script\b[^>]*\bsrc=["']\/?(src\/[^"']+)["']/g)) {
      // entry.ts dispatches separate launcher/tray/main windows; combining those
      // branches would incorrectly make the launcher's sheets appear to load DS.
      if (match[1] === 'src/entry.ts') for (const file of dependencies(match[1])) entries.add(file);
      else entries.add(match[1]);
    }
  }
  const graphs = [...entries].map(entry => {
    const files = new Set();
    const visit = file => {
      if (files.has(file) || /^src\/preview(?:[-.]|$)/.test(file)) return;
      files.add(file);
      for (const next of dependencies(file)) visit(next);
    };
    visit(entry);
    return files;
  });
  const guarded = new Set(graphs.filter(files => files.has('src/design-system.css')).flatMap(files => [...files]));
  const exemptFiles = new Set(graphs.filter(files => !files.has('src/design-system.css')).flatMap(files => [...files]).filter(file => !guarded.has(file)));
  selectPolicy = { exemptFiles, exemptSheets: new Set([...exemptFiles].filter(file => file.endsWith('.css'))) };
  return selectPolicy;
}
