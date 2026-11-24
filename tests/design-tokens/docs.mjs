/**
 * Lock the documented design scale to canonical CSS definitions and alias policy.
 * Input is the repo's Markdown dialect: ### Type roles and ### Radius pipe tables,
 * backticked token sentences for weights/tracking/core/row leadings, and exactly
 * one ### Aliases heading whose first table is alias | value | defined in.
 * Each alias row has one backticked name plus backticked values and src/ owners.
 * Tables are line-based and split on pipes; this is not a general Markdown parser.
 *
 * The lock compares role size/weight/leading/tracking, radii, core primitives,
 * fixed row/control leadings, alias values/owners and duplicate/new locked tokens.
 * Token whitespace is normalized; alias zero and zero pixels are equivalent.
 * Alias exceptions remain governed by ALIASES/ALIAS_VALUES in allowlists.mjs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, ROW_LEADING, EM_TOKENS } from './allowlists.mjs';
import { parseBlocks, stripComments, declarations, tokenSource } from './parser.mjs';

export { tightContainerProblems } from './gu-containers.mjs';
export { markdownTypographyProblems, markdownEffectiveStyle, markdownEffectiveStyles, markdownHosts, mainMarkdownSheets } from './markdown-parity.mjs';
/** Normalize token whitespace and leading decimal zero spelling for scale comparisons. */
export function normToken(value) {
  return value.replace(/\s+/g, '').replace(/^0+(?=\.)/, '').replace(/^-0+(?=\.)/, '-');
}

/** Normalize core-token spacing around commas and parentheses while preserving meaningful spaces. */
export function normCore(value) {
  return value.trim().replace(/\s*,\s*/g, ',').replace(/\s*\(\s*/g, '(').replace(/\s*\)\s*/g, ')').replace(/\s+/g, ' ');
}

/** Read the first backticked custom-property name from a Markdown cell. */
export function cellToken(cell) {
  const match = /`--([^`]+)`/.exec(cell);
  return match ? `--${match[1]}` : '';
}

/** Read text after a heading through the next level-two or level-three heading. */
export function sectionSlice(md, heading) {
  const start = md.indexOf(heading);
  if (start < 0) return '';
  const rest = md.slice(start + heading.length);
  const next = rest.search(/\n#{2,3} /);
  return next < 0 ? rest : rest.slice(0, next);
}

/** Read the first contiguous pipe table, excluding alignment rows. */
export function markdownTable(slice) {
  const lines = slice.split('\n');
  let headers = null;
  const rows = [];
  for (const line of lines) {
    if (!line.trim().startsWith('|')) {
      if (headers) break;
      continue;
    }
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
    if (cells.every(cell => /^:?-+:?$/.test(cell))) continue;
    if (!headers) headers = cells;
    else rows.push(cells);
  }
  return { headers: headers || [], rows };
}

/** Resolve sole-variable aliases in a map until a terminal value, missing name or cycle. */
export function resolveToken(map, name, seen = new Set()) {
  const value = map.get(name);
  if (value == null) return '';
  const ref = /^var\((--[\w-]+)\)$/.exec(value.replace(/\s+/g, ''));
  if (!ref || seen.has(name)) return normToken(value);
  seen.add(name);
  return resolveToken(map, ref[1], seen);
}

/** Parse supplied Markdown (or the repository reference) into the complete documented scale and alias lock. */
export function loadRulebook(md = readFileSync(join(root, 'docs/agent-reference.md'), 'utf8')) {
  const typeTable = markdownTable(sectionSlice(md, '### Type roles'));
  const radiusTable = markdownTable(sectionSlice(md, '### Radius'));
  const roles = typeTable.rows.map(row => {
    const weight = /\((strong|medium|regular)\)/.exec(row[2] || []);
    return {
      name: cellToken(row[0]),
      size: (row[1] || '').trim().split(/\s+/)[0],
      weight: cellToken(row[2]),
      weightVar: weight ? `--weight-${weight[1]}` : '',
      leading: cellToken(row[3]),
      leadingValue: (/\(([\d.]+)\)/.exec(row[3] || '') || [])[1] || '',
      tracking: cellToken(row[4]),
    };
  });
  const weights = Object.fromEntries([...md.matchAll(/`--weight-([\w-]+)`\s+is\s+(\d+)/g)].map(match => [`--weight-${match[1]}`, match[2]]));
  const tracking = Object.fromEntries([...md.matchAll(/`--tracking-([\w-]+)`\s+is\s+`([^`]+)`/g)].map(match => [`--tracking-${match[1]}`, match[2]]));
  const leadings = Object.fromEntries([...md.matchAll(/`--leading-([\w-]+)`(?:\s+is)?\s+(\d+(?:\.\d+)?)/g)].map(match => [`--leading-${match[1]}`, match[2]]));
  const compactLeading = (/`--type-prose-compact-leading` is (\d+(?:\.\d+)?)/.exec(md) || [])[1] || '';
  const radii = Object.fromEntries(radiusTable.rows.map(row => [cellToken(row[0]), (row[1] || '').trim().split(/\s+/)[0]]));
  const heights = Object.fromEntries([...md.matchAll(/`--((?:row|control)(?:-[\w-]+)?|ds-row-h(?:-sub)?|ds-btn(?:-primary)?-h)`\s+is\s+(\d+px)/g)].map(match => [`--${match[1]}`, match[2]]));
  const core = Object.fromEntries(
    ['--root-size', '--mono-size', '--sans', '--mono'].map(name => {
      const match = new RegExp(`\`${name}\`\\s+is\\s+\`([^\`]+)\``).exec(md);
      return [name, match ? match[1] : ''];
    }),
  );
  const aliases = new Map();
  const aliasHeadings = [...md.matchAll(/^### Aliases\r?$/gm)];
  if (aliasHeadings.length !== 1) throw new Error('docs/agent-reference.md must contain exactly one ### Aliases heading');
  const aliasTable = markdownTable(sectionSlice(md.slice(aliasHeadings[0].index), '### Aliases'));
  if (aliasTable.headers.join('|') !== 'alias|value|defined in') {
    throw new Error('### Aliases first table must have columns alias | value | defined in');
  }
  for (const row of aliasTable.rows) {
    const name = /^`(--[\w-]+)`$/.exec(row[0] || '')?.[1];
    const values = new Set([...(row[1] || '').matchAll(/`([^`]+)`/g)].map(m => m[1].replace(/\s+/g, '')));
    const files = new Set([...(row[2] || '').matchAll(/`(src\/[^`]+)`/g)].map(m => m[1]));
    if (row.length !== 3 || !name || !values.size || !files.size || aliases.has(name)) {
      throw new Error(`### Aliases has an invalid or repeated row: ${row.join(' | ')}`);
    }
    aliases.set(name, { values, files });
  }
  const expected = new Set([
    ...roles.flatMap(role => [role.name, role.weight, role.leading, role.tracking]),
    ...Object.keys(weights),
    ...Object.keys(tracking),
    ...Object.keys(leadings),
    ...Object.keys(radii),
    ...Object.keys(heights),
    ...Object.keys(core),
  ]);
  if (compactLeading) expected.add('--type-prose-compact-leading');
  return { roles, weights, tracking, leadings, radii, expected, compactLeading, heights, core, aliases };
}

function normAliasVal(val) {
  const compact = val.replace(/\s+/g, '');
  return compact === '0px' ? '0' : compact;
}

/** Compare alias names, normalized values and defining file sets in both directions. */
export function compareAliases(aliasValues, docAliases) {
  const problems = [];
  for (const [name, spec] of aliasValues.entries()) {
    const doc = docAliases.get(name);
    if (!doc) {
      problems.push(`${name} is in ALIAS_VALUES but missing from docs/agent-reference.md`);
      continue;
    }
    const codeVals = new Set([...spec.values].map(normAliasVal));
    const docVals = new Set([...doc.values].map(normAliasVal));
    const sameVals = codeVals.size === docVals.size && [...codeVals].every(v => docVals.has(v));
    if (!sameVals) {
      problems.push(`${name} values in ALIAS_VALUES (${[...codeVals].sort().join(', ')}) do not match docs (${[...docVals].sort().join(', ')})`);
    }
    const codeFiles = spec.files || new Set();
    const docFiles = doc.files || new Set();
    const sameFiles = codeFiles.size === docFiles.size && [...codeFiles].every(f => docFiles.has(f));
    if (!sameFiles) {
      problems.push(`${name} owners in ALIAS_VALUES (${[...codeFiles].sort().join(', ')}) do not match docs (${[...docFiles].sort().join(', ')})`);
    }
  }
  for (const name of docAliases.keys()) {
    if (!aliasValues.has(name)) {
      problems.push(`${name} is documented as a pinned alias but missing from ALIAS_VALUES`);
    }
  }
  return problems;
}

/** Report type/radius/weight/tracking/leading/row/control names absent from the documented set. */
export function unexpectedLocked(names, expected) {
  const problems = [];
  for (const name of names) {
    if (/^(?:--(?:type|radius|weight|tracking|leading|row|control)-|--(?:row|control)$)/.test(name) && !expected.has(name)) {
      problems.push(`${name} is not in the docs tables`);
    }
  }
  return problems;
}

/** Compare canonical token values and type-role pairings with the parsed rulebook. */
export function compareRulebook(map, book) {
  const problems = [];
  for (const role of book.roles) {
    if (!role.name) continue;
    const size = normToken(map.get(role.name) || '');
    if (size !== normToken(role.size)) problems.push(`${role.name} is ${size || '(missing)'}, docs say ${role.size}`);
    const weight = (map.get(role.weight) || '').replace(/\s+/g, '');
    if (weight !== `var(${role.weightVar})`) problems.push(`${role.weight} is ${weight || '(missing)'}, docs say var(${role.weightVar})`);
    const leading = normToken(map.get(role.leading) || '');
    if (leading !== normToken(role.leadingValue)) problems.push(`${role.leading} is ${leading || '(missing)'}, docs say ${role.leadingValue}`);
    const codeTracking = CODE_TRACKING[role.name.slice('--type-'.length)];
    if (codeTracking && role.tracking !== codeTracking) problems.push(`${role.name} tracking is ${role.tracking || '(missing)'}, code says ${codeTracking}`);
    if (role.tracking && !(map.get(role.tracking) || '').replace(/\s+/g, '')) problems.push(`${role.tracking} is missing from tokens.css`);
  }
  for (const [name, value] of Object.entries(book.weights)) {
    if (normToken(map.get(name) || '') !== normToken(value)) problems.push(`${name} is ${map.get(name) || '(missing)'}, docs say ${value}`);
  }
  for (const [name, value] of Object.entries(book.tracking)) {
    if (normToken(map.get(name) || '') !== normToken(value)) problems.push(`${name} is ${map.get(name) || '(missing)'}, docs say ${value}`);
  }
  for (const [name, value] of Object.entries(book.leadings)) {
    if (resolveToken(map, name) !== normToken(value)) problems.push(`${name} resolves to ${resolveToken(map, name) || '(missing)'}, docs say ${value}`);
  }
  if (book.compactLeading) {
    const got = normToken(map.get('--type-prose-compact-leading') || '');
    if (got !== normToken(book.compactLeading)) problems.push(`--type-prose-compact-leading is ${got || '(missing)'}, docs say ${book.compactLeading}`);
  }
  for (const [name, value] of Object.entries(book.radii)) {
    if (!name) continue;
    if (normToken(map.get(name) || '') !== normToken(value)) problems.push(`${name} is ${map.get(name) || '(missing)'}, docs say ${value}`);
  }
  for (const [name, value] of Object.entries(book.core || {})) {
    if (!value) {
      problems.push(`${name} is missing from docs/agent-reference.md`);
      continue;
    }
    const got = map.get(name) || '';
    if (normCore(got) !== normCore(value)) problems.push(`${name} is ${got || '(missing)'}, docs say ${value}`);
  }
  return problems;
}

const CODE_TRACKING = {
  display: '--tracking-tight', title: '--tracking-tight', heading: '--tracking-tight',
  subheading: '--tracking-none', body: '--tracking-none', prose: '--tracking-none',
  meta: '--tracking-none', caption: '--tracking-none',
};

/** Row, control and button heights used as line-heights must match the docs sentence. */
/** Require every consumed row leading to be documented and every documented height to match its owning sheet. */
export function lockRowLeadings(used, tokens, design, heights) {
  const problems = [];
  for (const key of used) {
    if (!key.startsWith('rowlead:')) continue;
    const name = key.slice('rowlead:'.length);
    if (!heights[name]) problems.push(`${name} is used as a line-height and is not locked in the docs`);
  }
  for (const [name, px] of Object.entries(heights)) {
    const source = name.startsWith('--ds-') ? design : tokens;
    const got = (source.get(name) || '').replace(/\s+/g, '');
    if (got !== px) problems.push(`${name} is ${got || '(missing)'}, docs say ${px}`);
  }
  return problems;
}

/** Report repeated locked declarations or @property registrations within an owning stylesheet. */
export function repeatedLocked(css, book, file = 'src/tokens.css') {
  const seen = new Set();
  const problems = [];
  const isLocked = property => book.expected.has(property) || ROW_LEADING.test(property)
    || (tokenSource.has(property) && /^(?:--(?:root-size|mono-size|sans|mono)|--(?:space|icon)-[\w-]+)$/.test(property));
  for (const block of parseBlocks(stripComments(css))) {
    if (block.selector.startsWith('@property')) {
      const name = block.selector.replace(/^@property\s+/, '').trim();
      if (isLocked(name)) {
        if (seen.has(name)) problems.push(`${file}: repeated canonical definition ${name}`);
        seen.add(name);
      }
      continue;
    }
    for (const { property } of declarations(block.body)) {
      if (!isLocked(property)) continue;
      if (seen.has(property)) problems.push(`${file}: repeated canonical definition ${property}`);
      seen.add(property);
    }
  }
  return problems;
}

/** Lock each canonical em token's documented value (`--name` is `value`) to its live src/tokens.css value. */
export function emTokenDocProblems(map, md = readFileSync(join(root, 'docs/agent-reference.md'), 'utf8')) {
  const problems = [];
  for (const name of EM_TOKENS) {
    const live = normToken(map.get(name) || '');
    const docs = [...md.matchAll(new RegExp(`\`${name}\` is \`([^\`]+)\``, 'g'))].map(match => normToken(match[1]));
    if (!live) problems.push(`${name} is missing from src/tokens.css`);
    if (docs.length !== 1) problems.push(`${name} needs exactly one "\`${name}\` is \`value\`" sentence in docs/agent-reference.md, found ${docs.length}`);
    else if (docs[0] !== live) problems.push(`${name} is ${live || '(missing)'}, docs say ${docs[0]}`);
  }
  return problems;
}

/**
 * Lock every value AGENTS.md quotes beside a canonical em token (`` `--name` (value) ``) to the
 * live src/tokens.css value; `--code-inline-size` must be quoted at least once.
 */
export function agentsEmValueProblems(map, agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')) {
  const problems = [];
  for (const name of EM_TOKENS) {
    const live = normToken(map.get(name) || '');
    const quoted = [...agents.matchAll(new RegExp(`\`${name}\` \\(([^)\\s]+)\\)`, 'g'))].map(match => normToken(match[1]));
    if (name === '--code-inline-size' && !quoted.length) problems.push(`AGENTS.md must quote the ${name} value as "\`${name}\` (value)"`);
    for (const value of quoted) if (value !== live) problems.push(`AGENTS.md quotes ${name} as ${value}, src/tokens.css has ${live || '(missing)'}`);
  }
  return problems;
}
