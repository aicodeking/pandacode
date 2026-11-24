/**
 * Shared constant-string folding for the static design-token guard (docs.mjs and flow.mjs).
 * A guard that only reads single string literals is bypassed by building the same text from
 * pieces: `'attach' + 'Shadow'`, `` `attach${'Shadow'}` ``, `['attach', 'Shadow'].join('')`.
 * evalConstString() folds a whole expression to its constant string (or null); foldedStrings()
 * walks a subtree and yields every maximal constant run with the node it starts at, folding the
 * constant runs next to dynamic operands too (`X + '.gu-' + 'card'` yields `.gu-card`).
 * Identifiers are never resolved: a binding (`const k = 'attach'`) is a dynamic operand.
 */
import ts from 'typescript';

/** Strip parentheses, `as const` / `as T`, `satisfies`, `<T>x` and `x!`. */
export function unwrapExpr(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isNonNullExpression(node) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(node)))) node = node.expression;
  return node;
}

const isPlus = node => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
/** The operands of a `+` chain, left to right (parentheses inside the chain are looked through). */
export const plusOperands = node => {
  const bare = unwrapExpr(node);
  return isPlus(bare) ? [...plusOperands(bare.left), ...plusOperands(bare.right)] : [node];
};

/** `<array>.join(sep?)`: the array literal and the separator node (undefined means the default `,`), or null. */
function joinParts(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'join' || node.arguments.length > 1) return null;
  const array = unwrapExpr(node.expression.expression);
  return ts.isArrayLiteralExpression(array) ? { array, sep: node.arguments[0] } : null;
}

/** The constant string an expression folds to, or null when any part is dynamic. */
export function evalConstString(input) {
  const node = unwrapExpr(input);
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (isPlus(node)) {
    const left = evalConstString(node.left);
    const right = left === null ? null : evalConstString(node.right);
    return right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      const value = evalConstString(span.expression);
      if (value === null) return null;
      text += value + span.literal.text;
    }
    return text;
  }
  const join = joinParts(node);
  if (join) {
    const sep = join.sep ? evalConstString(join.sep) : ',';
    if (sep === null) return null;
    const items = join.array.elements.map(item => (ts.isSpreadElement(item) || ts.isOmittedExpression(item) ? null : evalConstString(item)));
    return items.includes(null) ? null : items.join(sep);
  }
  return null;
}

/**
 * Every maximal constant string under `root`, as `{ node, text }` (node = where the run starts),
 * in source order. Constant subtrees are yielded whole and not re-entered; in a `+` chain, a
 * template or a `.join()` with dynamic parts, each adjacent constant run is folded and the
 * dynamic parts are walked in turn. Comments are not AST nodes, so they never count.
 */
export function foldedStrings(root) {
  const out = [];
  const runs = pieces => {
    let run = null;
    for (const piece of [...pieces, null]) {
      if (piece && piece.text !== null) { run = run ? { node: run.node, text: run.text + piece.text } : { node: piece.node, text: piece.text }; continue; }
      if (run) { out.push(run); run = null; }
      if (piece) visit(piece.node);
    }
  };
  const visit = node => {
    if (!node) return;
    const text = ts.isExpression(node) ? evalConstString(node) : null;
    if (text !== null) { out.push({ node, text }); return; }
    if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) { out.push({ node, text: node.text }); return; }
    const bare = unwrapExpr(node);
    if (isPlus(bare)) {
      runs(plusOperands(bare).map(item => ({ node: item, text: evalConstString(item) })));
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const pieces = [{ node: node.head, text: node.head.text }];
      for (const span of node.templateSpans) pieces.push({ node: span.expression, text: evalConstString(span.expression) }, { node: span.literal, text: span.literal.text });
      runs(pieces);
      return;
    }
    const join = joinParts(node);
    const sep = join && (join.sep ? evalConstString(join.sep) : ',');
    if (join && sep !== null) {
      const pieces = [];
      join.array.elements.forEach((item, index) => {
        const value = ts.isSpreadElement(item) || ts.isOmittedExpression(item) ? null : evalConstString(item);
        // The separator joins two neighbours only when both are constant; it belongs to the later one.
        const lead = index && value !== null && pieces.at(-1)?.text !== null ? sep : '';
        pieces.push({ node: item, text: value === null ? null : lead + value });
      });
      runs(pieces);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return out;
}

/** The text of every maximal constant string under `root` (see foldedStrings). */
export const collectFoldedStrings = root => foldedStrings(root).map(item => item.text);
