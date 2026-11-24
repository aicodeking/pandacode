/**
 * Selector matching for Markdown parity: does a rule's selector reach one sample element path?
 *
 * A sample is [context x CONTEXT_DEPTH, root, root, ...path]. Context elements stand for any
 * outer wrapper: a class, id or attribute (open scenarios only), `:host`, `:root`, a generic
 * container tag or `*`. Root elements carry the host's Markdown root classes. Path elements are
 * the sample's own tags; in open scenarios an ancestor path element (never the subject) named by
 * its tag may also carry unknown classes, ids or attributes, so `ul.task-list code` reaches list
 * code, while a bare `.card` stays an outer wrapper and `a.citation` a distinct element kind.
 *
 * `:is()`/`:where()`/`:matches()` alternatives and `:not()` arguments are complex selectors
 * matched against the full ancestor chain of the element, with the same compound and combinator
 * rules as the outer selector. `:not()` excludes only on a certain match: its argument is matched
 * strictly, where unknown context elements and unknown classes never match, so
 * `code:not(pre code)` reaches inline code and rejects code inside `pre`.
 */
import { splitTop, parseSelectorChain } from './parser.mjs';

export const GENERIC_TAGS = new Set(['div', 'section', 'article', 'main', 'aside', 'body', 'html', '*']);
/** Unknown ancestors left of the root: enough slots for the deepest outer context in the repo. */
export const CONTEXT_DEPTH = 4;
const PSEUDO_FN = /^:{1,2}([-\w]+)\(/;
const LIST_PSEUDOS = new Set(['is', 'where', 'matches']);

/** Split a compound into base text and its functional pseudo groups (is/where/not/other). */
export function compoundGroups(compound) {
  const groups = [];
  let base = '';
  for (let i = 0; i < compound.length; i++) {
    const match = compound[i] === ':' ? PSEUDO_FN.exec(compound.slice(i)) : null;
    if (!match) { base += compound[i]; continue; }
    let depth = 1, k = i + match[0].length, inner = '';
    for (; k < compound.length; k++) {
      if (compound[k] === '(') depth++;
      else if (compound[k] === ')' && --depth === 0) break;
      inner += compound[k];
    }
    groups.push({ name: match[1].toLowerCase(), double: compound.startsWith('::', i), inner });
    i = k;
  }
  return { base, groups };
}

export const sumSpec = specs => specs.reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], [0, 0, 0]);
export const compareSpec = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Selector specificity of one compound as [ids, classes-ish, types]. */
export function specificity(compound) {
  const { base, groups } = compoundGroups(compound);
  const plain = base.replace(/\[[^\]]*\]/g, ' .a ');
  const ids = (plain.match(/#[-\w]+/g) || []).length;
  let classes = (plain.match(/[.:][-\w]+/g) || []).filter(token => !token.startsWith('::')).length;
  let types = /^[a-z][\w-]*/i.test(plain) ? 1 : 0;
  types += (plain.match(/::[-\w]+/g) || []).length;
  let idTotal = ids;
  for (const group of groups) {
    if (group.name === 'where') continue;
    if (LIST_PSEUDOS.has(group.name) || group.name === 'not' || group.name === 'has') {
      const best = splitTop(group.inner, /,/).map(alt => sumSpec(parseSelectorChain(alt).compounds.map(specificity))).sort((a, b) => compareSpec(b, a))[0] || [0, 0, 0];
      idTotal += best[0];
      classes += best[1];
      types += best[2];
    } else classes += 1;
  }
  return [idTotal, classes, types];
}

/** Does one compound match elements[ei] (an outer context, a host root or a path tag)? */
function compoundMatchesElement(compound, elements, ei, roots, strict) {
  const element = elements[ei];
  const { base, groups } = compoundGroups(compound);
  if (groups.some(group => group.double) || /::/.test(base)) return false;
  const classes = (base.match(/\.(-?[_a-zA-Z][-\w]*)/g) || []).map(name => name.slice(1));
  const tag = (/^([a-z][\w-]*|\*)/i.exec(base.trim()) || [])[1]?.toLowerCase() || '';
  const hostish = /:(?:root|host|scope|host-context)(?![-\w])/i.test(compound);
  const groupsAllow = () => groups.every(group => groupAllows(group, elements, ei, roots, strict));
  if (element.context) {
    // Any outer element could wrap a Markdown block; a strict (:not) match never relies on one.
    if (strict || (tag && !GENERIC_TAGS.has(tag))) return false;
    if (!element.open && /[.#[]/.test(base)) return false;
    return groupsAllow();
  }
  if (hostish) return false;
  if (element.root) {
    if (/[#[]/.test(base)) return false;
    if (tag && tag !== 'div' && tag !== '*') return false;
    if (classes.some(name => !roots.includes(name))) return false;
  } else {
    // Unknown classes, ids and attributes fit an ancestor path element only in an open, non-strict
    // scenario and only beside its explicit tag (`ul.task-list`); a bare `.card` is an outer wrapper.
    if (/[.#[]/.test(base) && (strict || !element.open || element.last || tag !== element.tag)) return false;
    if (tag && tag !== '*' && tag !== element.tag) return false;
  }
  if (!groupsAllow()) return false;
  if (element.root) return classes.length > 0 || groups.some(group => group.name !== 'not');
  return true;
}

/** Selector-list pseudos need a matching complex alternative; :not must not certainly match; other pseudos are states. */
function groupAllows(group, elements, ei, roots, strict) {
  const isNot = group.name === 'not';
  if (!LIST_PSEUDOS.has(group.name) && !isNot) return true;
  if (isNot && elements[ei].context) return true;
  const hit = splitTop(group.inner, /,/).some(alt => chainMatchesAt(parseSelectorChain(alt), elements, ei, roots, isNot || strict));
  return isNot ? !hit : hit;
}

/** Match a parsed chain whose subject is elements[ei], honouring descendant and child combinators. */
function chainMatchesAt({ compounds, combinators }, elements, ei, roots, strict) {
  if (!compounds.length || combinators.some(comb => comb === '+' || comb === '~')) return false;
  const match = (ci, at) => {
    if (!compoundMatchesElement(compounds[ci], elements, at, roots, strict)) return false;
    if (ci === 0) return true;
    if (combinators[ci - 1] === '>') return at > 0 && match(ci - 1, at - 1);
    for (let k = at - 1; k >= 0; k--) if (match(ci - 1, k)) return true;
    return false;
  };
  return match(compounds.length - 1, ei);
}

/** Match a selector branch against [context..., root, root, ...path]. */
export function branchMatches(branch, path, roots, open = true) {
  const elements = [
    ...Array.from({ length: CONTEXT_DEPTH }, () => ({ context: true, open })),
    { root: true }, { root: true },
    ...path.map((tag, index) => ({ tag, open, last: index === path.length - 1 })),
  ];
  return chainMatchesAt(parseSelectorChain(branch), elements, elements.length - 1, roots, false);
}

/** Expand a whole-compound :is()/:where() whose alternatives carry their own combinators into plain branches. */
export function expandBranch(branch) {
  const { compounds, combinators } = parseSelectorChain(branch);
  for (const [index, compound] of compounds.entries()) {
    const whole = /^:(?:is|where)\((.*)\)$/s.exec(compound);
    if (!whole || compoundGroups(compound).groups.length !== 1) continue;
    const alts = splitTop(whole[1], /,/);
    if (!alts.some(alt => parseSelectorChain(alt).compounds.length > 1)) continue;
    const join = parts => parts.map((part, i) => (i ? (combinators[i - 1] === ' ' ? ' ' : combinators[i - 1]) : '') + part).join('');
    return alts.flatMap(alt => expandBranch(join([...compounds.slice(0, index), alt.trim(), ...compounds.slice(index + 1)])));
  }
  return [branch];
}

const reachMemo = new Map();
/** Highest specificity of the branches reaching a sample with any outer ancestors (open) and with plain ones only; memoized per selector. */
export function ruleReach(rule, path, roots) {
  const key = `${path.join('/')}|${roots.join()}`;
  let memo = reachMemo.get(rule.selector);
  if (!memo) reachMemo.set(rule.selector, memo = new Map());
  if (memo.has(key)) return memo.get(key);
  const branches = splitTop(rule.selector, /,/);
  const best = open => branches.filter(branch => expandBranch(branch).some(item => branchMatches(item, path, roots, open)))
    .map(branch => sumSpec(parseSelectorChain(branch).compounds.map(specificity))).sort((a, b) => compareSpec(b, a))[0] || null;
  const open = best(true);
  const result = open ? { open, plain: best(false) } : null;
  memo.set(key, result);
  return result;
}
