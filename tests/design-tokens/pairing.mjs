/**
 * Pair effective typography within one static selector/declaration context.
 * Input is the parser's normalized declaration list (including !important) and
 * expanded selector grammar: combinators, selector lists and :is/:where groups.
 * This is not stylesheet-wide cascade or DOM inheritance analysis.
 *
 * Each longhand keeps its own priority; font/all resets cannot leave stale size,
 * weight or leading behind. Heading roles, caption/mono leading, control body
 * medium, prose emphasis, uppercase tracking and input resets stay consistent.
 * Exact CONTROLS/TRACKING/LINE_HEIGHTS exceptions are consumed through usage keys;
 * extend them only under the reasons documented in allowlists.mjs.
 */
import { EM_TOKENS, LEADING_ROLES, TRACKING_ROLES, SOFT_ROLES, CONTROLS, TRACKING, ROW_LEADING, LINE_HEIGHTS } from './allowlists.mjs';
import {
  soleVar, firstVar, eachVar, fontParts, sizeRole, leadingMatches, rootSelector,
  isControlSelector, isMediumWeight, monoContext, take, splitTop, zeroLength,
  parseSelectorChain, extractCompoundParts, compoundMatches, hasAncestorMatching,
  hasPseudoElement, resolvedTypography,
} from './parser.mjs';

const ROLE_WEIGHT = /^--type-(display|title|heading|subheading)-weight$/;
const CODE_INLINE = EM_TOKENS[0];
const MD_CODE_LEADINGS = new Set(['--leading-code', '--type-meta-leading', '--type-body-leading', '--type-caption-leading']);
const ROLE_LEADING = /^--type-(display|title|heading|caption)-leading$/;
const CSS_WIDE = /^(?:inherit|initial|unset|revert|revert-layer)$/i;
const FONT_WEIGHT_CLOBBER = /^(?:inherit|initial|unset|revert|revert-layer)$/i;
const BASE_STYLE_FILES = new Set([
  'src/styles.css',
  'src/overlay.css',
  'src/tray-popover.css',
  'src/generative-ui.css',
  'src/shadow-base.css',
  'src/generative-ui-components.ts',
  'src/rich-markdown.ts',
]);
const PROSE_STRONG_CLASS = /\.(?:markdown|message-meta|gu-md|rich-markdown|launcher-thread-message)(?![-\w\\])/;
const MARKDOWN_PROSE_CLASS = /\.(?:markdown|gu-md|rich-markdown|launcher-thread-message)(?![-\w\\])/;
const PROSE_CONTAINER_CLASS = /\.(?:markdown|message-content|gu-md|rich-markdown|launcher-thread-message)(?![-\w\\])/;

const isProseStrongBase = base => PROSE_STRONG_CLASS.test(base);
const isMarkdownProseBase = base => MARKDOWN_PROSE_CLASS.test(base);
const isProseContainerBase = base => PROSE_CONTAINER_CLASS.test(base);
const isProseTextBase = base => /^(?:p|li|blockquote|dd|td)(?![-\w\\])/i.test(base);
const isBoldBase = base => /^(?:strong|b)(?![-\w\\])/i.test(base);
const isHeadingBase = base => /^h[1-6](?![-\w\\])/i.test(base);
const isProseBlockBase = base => /^(?:table|p|li|blockquote|ul|ol)(?![-\w\\])/i.test(base);
const isFormFieldBase = base => /^(?:input|select|textarea)(?![-\w\\])/i.test(base);

function compoundMatchesAny(compound, testBase) {
  const { base, groups } = extractCompoundParts(compound);
  if (testBase(base)) return true;
  return groups.some(group => splitTop(group, /,/).some(branch => {
    const subject = parseSelectorChain(branch).compounds.at(-1) || '';
    return Boolean(subject) && compoundMatchesAny(subject, testBase);
  }));
}

function hasAnyFormFieldSelector(selector) {
  return splitTop(selector, /,/).some(branch => {
    const chain = parseSelectorChain(branch);
    const subject = (chain.compounds.at(-1) || '').trim();
    if (!subject || hasPseudoElement(subject)) return false;
    return compoundMatchesAny(subject, isFormFieldBase);
  });
}

function hasSpecificFormFieldSelector(selector) {
  return splitTop(selector, /,/).some(branch => {
    const chain = parseSelectorChain(branch);
    const subject = (chain.compounds.at(-1) || '').trim();
    if (!subject || hasPseudoElement(subject)) return false;
    if (!compoundMatchesAny(subject, isFormFieldBase)) return false;
    if (chain.compounds.length > 1) return true;
    return !/^(?:input|select|textarea|:where\([^)]*\))$/i.test(subject);
  });
}

/** Append a diagnostic when a display/title/heading role lacks tight tracking. */
export function needsTracking(problems, where, selector, role, letter) {
  if (!TRACKING_ROLES.has(role)) return;
  if (soleVar(letter || '') !== '--tracking-tight') {
    problems.push(`${where}: ${selector}: font-size var(--type-${role}) needs letter-spacing var(--tracking-tight)`);
  }
}

/** Compute effective typography fields using per-longhand importance and shorthand/all resets. */
export function effectiveStyle(list) {
  const style = { size: '', weight: '', lineHeight: '', family: '', letter: '', transform: '' };
  const priorities = new Map();
  const fields = {
    'font-size': 'size', 'font-weight': 'weight', 'line-height': 'lineHeight',
    'font-family': 'family', 'letter-spacing': 'letter', 'text-transform': 'transform',
  };
  const set = (field, value, important) => {
    if (priorities.get(field) && !important) return;
    style[field] = value;
    priorities.set(field, Boolean(important));
  };
  for (const decl of list) {
    if (decl.property === 'all' && CSS_WIDE.test(decl.value)) {
      const kw = decl.value.toLowerCase();
      for (const field of Object.values(fields)) set(field, kw, decl.important);
    } else if (decl.property === 'font') {
      if (CSS_WIDE.test(decl.value)) {
        const kw = decl.value.toLowerCase();
        set('size', kw, decl.important);
        set('weight', kw, decl.important);
        set('lineHeight', kw, decl.important);
        set('family', kw, decl.important);
      } else {
        const parts = fontParts(decl.value);
        set('size', parts.size, decl.important);
        // Omitted shorthand fields reset at the shorthand's own priority.
        set('weight', parts.weight || 'normal', decl.important);
        set('lineHeight', parts.lineHeight || 'normal', decl.important);
        set('family', parts.family, decl.important);
      }
    } else if (fields[decl.property]) {
      set(fields[decl.property], decl.value, decl.important);
    }
  }
  return style;
}

function weightIsStrong(value) {
  if (firstVar(value || '') === '--weight-strong') return true;
  return /^(?:600)$/.test((value || '').replace(/\s+/g, ''));
}

/** Only prose bold may use --weight-strong without uppercase --tracking-caps: strong/b under a prose class
 * (.markdown, .message-meta, .gu-md, .rich-markdown, .launcher-thread-message) or a prose text block (p, li, blockquote, dd, td). */
function strongOnly(selector) {
  const parts = splitTop(selector, /,/);
  return parts.length > 0 && parts.every(part => {
    const chain = parseSelectorChain(part);
    const subject = chain.compounds.at(-1) || '';
    return Boolean(subject) && compoundMatches(subject, isBoldBase)
      && (hasAncestorMatching(chain, isProseStrongBase) || hasAncestorMatching(chain, isProseTextBase));
  });
}

function isMarkdownHeading(selector) {
  const parts = splitTop(selector, /,/);
  return parts.length > 0 && parts.every(part => {
    const chain = parseSelectorChain(part);
    const subject = chain.compounds.at(-1) || '';
    return Boolean(subject) && compoundMatches(subject, isHeadingBase) && hasAncestorMatching(chain, isMarkdownProseBase);
  });
}

/**
 * Bare Shadow DOM headings in src/shadow-base.css, like Markdown: `:where(h1,h2)` read
 * --md-heading-lg and `:where(h3,h4,h5,h6)` stay 1em, all strong with title leading and --tracking-none
 * (--tracking-tight stays for display, title and heading roles plus the wordmark allowlist).
 */
function isShadowBareHeading(selector, file) {
  if (file !== 'src/shadow-base.css') return false;
  const parts = splitTop(selector, /,/);
  return parts.length > 0 && parts.every(part => {
    const chain = parseSelectorChain(part);
    return chain.compounds.length === 1 && compoundMatches(chain.compounds[0], isHeadingBase);
  });
}

function isProseContainer(selector) {
  const parts = splitTop(selector, /,/);
  return parts.length > 0 && parts.every(part => {
    const chain = parseSelectorChain(part);
    const subject = chain.compounds.at(-1) || '';
    if (!subject) return false;
    if (compoundMatches(subject, isProseContainerBase)) return true;
    return compoundMatches(subject, isProseBlockBase) && hasAncestorMatching(chain, isMarkdownProseBase);
  });
}

/** Append violations for the effective role, weight, leading, tracking, control and form-reset combination. */
export function checkPair(selector, list, problems, where, file, used, defs = new Map()) {
  const style = effectiveStyle(list);
  if (/var\(/i.test(style.transform || '')) style.transform = resolvedTypography(style.transform, list, defs, file) ?? 'uppercase';
  const sizeVars = [];
  eachVar(style.size || '', name => sizeVars.push(name));
  const sizeRoles = new Set();
  const strictRoles = new Set();
  for (const name of sizeVars) {
    const roleMatch = /^--type-(display|title|heading|subheading|body|prose|meta|caption)$/.exec(name);
    if (roleMatch) {
      sizeRoles.add(roleMatch[1]);
      if (roleMatch[1] === 'display' || roleMatch[1] === 'title' || roleMatch[1] === 'heading' || roleMatch[1] === 'subheading') {
        strictRoles.add(roleMatch[1]);
      }
    } else if (name === '--thread-font') {
      sizeRoles.add('prose');
    }
  }
  for (const role of strictRoles) {
    if (soleVar(style.weight) !== `--type-${role}-weight`) {
      problems.push(`${where}: ${selector}: font-size var(--type-${role}) needs font-weight var(--type-${role}-weight)`);
    }
    if (LEADING_ROLES.has(role) && soleVar(style.lineHeight) !== `--type-${role}-leading`) {
      problems.push(`${where}: ${selector}: font-size var(--type-${role}) needs line-height var(--type-${role}-leading)`);
    }
    needsTracking(problems, where, selector, role, style.letter);
  }
  if (sizeVars.includes('--root-size') && !rootSelector(selector)) {
    problems.push(`${where}: ${selector}: font-size var(--root-size) is only allowed on :root or html`);
  }
  let weightSource = '';
  let weightImportant = false;
  for (const decl of list) {
    if (decl.property === 'all' && CSS_WIDE.test(decl.value)) {
      if (!weightImportant || decl.important) {
        weightSource = 'all';
        weightImportant = Boolean(decl.important);
      }
    } else if (decl.property === 'font') {
      if (!weightImportant || decl.important) {
        weightSource = 'font';
        weightImportant = Boolean(decl.important);
      }
    } else if (decl.property === 'font-weight') {
      if (!weightImportant || decl.important) {
        weightSource = 'font-weight';
        weightImportant = Boolean(decl.important);
      }
    }
  }
  if (weightSource === 'font' && FONT_WEIGHT_CLOBBER.test(style.weight)) {
    if (/^inherit$/i.test(style.weight)) {
      if (hasSpecificFormFieldSelector(selector)) {
        problems.push(`${where}: ${selector}: font: inherit on input/select/textarea overrides base body weight; add font-weight: var(--type-body-weight)`);
      } else if (hasAnyFormFieldSelector(selector) && !BASE_STYLE_FILES.has(file)) {
        problems.push(`${where}: ${selector}: font: inherit on input/select/textarea outside base stylesheets overrides design-system.css body weight; add font-weight: var(--type-body-weight)`);
      }
    } else if (hasAnyFormFieldSelector(selector)) {
      problems.push(`${where}: ${selector}: font: ${style.weight} on input/select/textarea overrides base body weight; add font-weight: var(--type-body-weight)`);
    }
  } else if (weightSource === 'font-weight' && CSS_WIDE.test(style.weight) && hasAnyFormFieldSelector(selector)) {
    problems.push(`${where}: ${selector}: font-weight: ${style.weight} on input/select/textarea overrides base body weight; add font-weight: var(--type-body-weight)`);
  } else if (weightSource === 'all' && CSS_WIDE.test(style.weight) && hasAnyFormFieldSelector(selector)) {
    problems.push(`${where}: ${selector}: all: ${style.weight} on input/select/textarea overrides base body weight; add font-weight: var(--type-body-weight)`);
  }
  const hasStrictLeadingRole = [...strictRoles].some(role => LEADING_ROLES.has(role));
  let mono;
  const isMono = () => (mono ??= monoContext(selector, style.size, style.family));
  const hasCaption = sizeRoles.has('caption');
  if (hasCaption) {
    const ok = Boolean(style.lineHeight)
      && !/^(?:inherit|initial|unset|revert|revert-layer|normal)$/.test(style.lineHeight)
      && leadingMatches('caption', style.lineHeight, file, selector, used, style.lineHeight.includes('--leading-code') && isMono());
    if (!ok) {
      problems.push(`${where}: ${selector}: font-size var(--type-caption) needs line-height var(--type-caption-leading), 1, or a row height`);
    }
  }
  if (!hasStrictLeadingRole && style.lineHeight) {
    for (const soft of sizeRoles) {
      if (soft === 'caption' || !SOFT_ROLES.has(soft)) continue;
      if (!leadingMatches(soft, style.lineHeight, file, selector, used, style.lineHeight.includes('--leading-code') && isMono())) {
        const label = soft === 'prose' && !sizeVars.includes('--type-prose') && sizeVars.includes('--thread-font')
          ? '--thread-font'
          : `--type-${soft}`;
        problems.push(`${where}: ${selector}: font-size var(${label}) line-height ${style.lineHeight} must be var(--type-${soft}-leading), 1, or a row height`);
      }
    }
  }
  const monoSize = sizeVars.includes('--mono-size');
  if (monoSize && style.lineHeight) {
    const lh = style.lineHeight;
    const lhName = soleVar(lh);
    const monoLhOk = /^(?:inherit|initial|unset|revert|revert-layer|normal)$/.test(lh)
      || /^(?:0|1)(?:\.0+)?$/.test(lh)
      || zeroLength(lh)
      || lhName === '--leading-code'
      || lhName === '--type-meta-leading'
      || lhName === '--type-body-leading'
      || (Boolean(lhName) && ROW_LEADING.test(lhName))
      || take(LINE_HEIGHTS, used, 'lh', item => item.file === file && item.selector === selector && item.value === lh);
    if (!monoLhOk) {
      problems.push(`${where}: ${selector}: font-size var(--mono-size) line-height ${lh} must be var(--leading-code), var(--type-meta-leading), var(--type-body-leading), 1, or a row height`);
    }
  }
  if (firstVar(style.lineHeight) === '--leading-code' && !isMono()) {
    problems.push(`${where}: ${selector}: --leading-code is only for var(--mono) or a monospace selector`);
  }
  if (sizeRoles.has('body') && isMediumWeight(style.weight) && !isControlSelector(selector)) {
    if (!take(CONTROLS, used, 'control', item => item.file === file && item.selector === selector)) {
      problems.push(`${where}: ${selector}: --type-body with --weight-medium is reserved for buttons and controls; name the control as a control (element, role, or class control word), or add it to CONTROLS with a reason`);
    }
  }
  const smallRoles = [...sizeRoles].filter(role => role === 'body' || role === 'meta' || role === 'caption' || role === 'prose');
  if (smallRoles.length && weightIsStrong(style.weight)) {
    const label = /\buppercase\b/i.test(style.transform) && soleVar(style.letter) === '--tracking-caps';
    if (!label) problems.push(`${where}: ${selector}: --weight-strong on --type-${smallRoles[0]} is only an uppercase label that also sets letter-spacing var(--tracking-caps)`);
  }
  if (soleVar(style.letter) === '--tracking-tight' && ![...sizeRoles].some(role => LEADING_ROLES.has(role))) {
    if (!take(TRACKING, used, 'track', item => item.file === file && item.selector === selector)) {
      problems.push(`${where}: ${selector}: letter-spacing var(--tracking-tight) is only for display, title and heading`);
    }
  }
  if (firstVar(style.lineHeight) === '--type-prose-compact-leading' && !sizeRoles.has('prose')) {
    problems.push(`${where}: ${selector}: --type-prose-compact-leading is only for --type-prose or --thread-font`);
  }
  const mdCode = sizeVars.includes(CODE_INLINE);
  if (mdCode && style.lineHeight && !/^inherit$/i.test(style.lineHeight) && !MD_CODE_LEADINGS.has(soleVar(style.lineHeight))) {
    problems.push(`${where}: ${selector}: font-size var(${CODE_INLINE}) line-height ${style.lineHeight} must be inherit, var(--leading-code), var(--type-meta-leading), var(--type-body-leading) or var(--type-caption-leading)`);
  }
  const leadingRole = ROLE_LEADING.exec(firstVar(style.lineHeight) || '');
  if (leadingRole && !sizeRoles.has(leadingRole[1]) && !(leadingRole[1] === 'title' && (isMarkdownHeading(selector) || isShadowBareHeading(selector, file))) && !(leadingRole[1] === 'caption' && mdCode)) {
    problems.push(`${where}: ${selector}: line-height var(--type-${leadingRole[1]}-leading) needs font-size var(--type-${leadingRole[1]})`);
  }
  if (firstVar(style.lineHeight) === '--type-prose-leading' && !sizeRoles.has('prose') && !isProseContainer(selector)) {
    problems.push(`${where}: ${selector}: --type-prose-leading is only for --type-prose, --thread-font, or a prose container`);
  }
  if (/\buppercase\b/i.test(style.transform) && soleVar(style.letter) !== '--tracking-caps') {
    problems.push(`${where}: ${selector}: uppercase text needs letter-spacing var(--tracking-caps)`);
  }
  if (soleVar(style.letter) === '--tracking-caps' && !/\buppercase\b/i.test(style.transform)) {
    problems.push(`${where}: ${selector}: letter-spacing var(--tracking-caps) requires text-transform: uppercase`);
  }
  const weightRole = ROLE_WEIGHT.exec(firstVar(style.weight) || '');
  if (weightRole && !sizeRoles.has(weightRole[1])) {
    problems.push(`${where}: ${selector}: font-weight var(--type-${weightRole[1]}-weight) needs font-size var(--type-${weightRole[1]})`);
  }
  const implicitSize = !style.size || CSS_WIDE.test(style.size);
  if (weightIsStrong(style.weight) && implicitSize) {
    const caps = /\buppercase\b/i.test(style.transform) && soleVar(style.letter) === '--tracking-caps';
    if (!caps && !strongOnly(selector)) {
      problems.push(`${where}: ${selector}: font-weight var(--weight-strong) with no role font-size is only for prose strong/b or an uppercase --tracking-caps label`);
    }
  }
  if (monoSize && weightIsStrong(style.weight)) {
    problems.push(`${where}: ${selector}: --mono-size must not use --weight-strong`);
  }
}

const TYPO_PROPS = /^(?:font|font-size|font-weight|line-height|letter-spacing|text-transform|all)$/;
const CONDITIONAL_AT = /^@(?:media|supports|container)\b/i;
const STATE_GROUP = /:(?:is|where)\(\s*(?::(?:hover|focus|focus-visible|focus-within|active)\s*,?\s*)+\)/gi;
const STATE_PSEUDO = /:(?:hover|focus|focus-visible|focus-within|active)(?![-\w])/gi;
const normSel = branch => branch.replace(/\s+/g, ' ').replace(/\s*([>+~])\s*/g, '$1').trim();
const unstated = branch => normSel(branch.replace(STATE_GROUP, '').replace(STATE_PSEUDO, ''));
const conditional = block => {
  for (let cur = block.parentBlock; cur; cur = cur.parentBlock) if (CONDITIONAL_AT.test(cur.selector || '')) return true;
  return false;
};
const strip = (hits, file, selector) => hits.map(hit => hit.startsWith(`${file}: ${selector}: `) ? hit.slice(`${file}: ${selector}: `.length) : hit);

/**
 * Pair each @media/@supports/@container or :hover/:focus/:active override with the
 * unconditional rule it modifies, so a state or breakpoint cannot swap a role's
 * weight, leading, tracking or size out from under it. Only new problems are
 * reported; the base and the override alone are checked by checkPair already.
 * Allowlist usage is read from a scratch copy so an override never marks an entry used.
 */
export function stateOverrideProblems(file, blocks, declarationsOf, used, defs = new Map()) {
  const base = new Map();
  for (const block of blocks) {
    if (block.parentBlock || !block.selector || block.selector.startsWith('@')) continue;
    const list = declarationsOf(block.body);
    if (!list.some(decl => TYPO_PROPS.test(decl.property))) continue;
    for (const branch of splitTop(block.selector, /,/)) {
      const key = normSel(branch);
      base.set(key, [...(base.get(key) || []), ...list]);
    }
  }
  const problems = [];
  for (const block of blocks) {
    const selector = block.effectiveSelector;
    if (!selector || (!block.parentBlock && !STATE_PSEUDO.test(selector))) { STATE_PSEUDO.lastIndex = 0; continue; }
    STATE_PSEUDO.lastIndex = 0;
    const list = declarationsOf(block.body).filter(decl => TYPO_PROPS.test(decl.property));
    if (!list.length) continue;
    const scoped = conditional(block);
    for (const branch of splitTop(selector, /,/)) {
      const key = unstated(branch);
      if (!scoped && key === normSel(branch)) continue;
      const baseList = base.get(key);
      if (!baseList || baseList === list) continue;
      const scratch = () => new Set(used);
      const before = [], alone = [], merged = [];
      checkPair(key, baseList, before, file, file, scratch(), defs);
      checkPair(key, list, alone, file, file, scratch(), defs);
      checkPair(key, [...baseList, ...list], merged, file, file, scratch(), defs);
      const known = new Set([...strip(before, file, key), ...strip(alone, file, key)]);
      for (const hit of strip(merged, file, key)) {
        if (!known.has(hit)) problems.push(`${file}: ${normSel(branch)}: ${scoped ? 'conditional' : 'state'} override of ${key} breaks its type pairing: ${hit}`);
      }
    }
  }
  return [...new Set(problems)];
}
