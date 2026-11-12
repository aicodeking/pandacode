
/** Each `<HeaderActions … />` element's props, braces balanced (props hold arrows, so `>` alone can't end it). */
function headerActionsProps(source: string): string[] {
  const found: string[] = [];
  for (let start = source.indexOf('<HeaderActions'); start >= 0; start = source.indexOf('<HeaderActions', start + 1)) {
    let depth = 0;
    let end = start + '<HeaderActions'.length;
    for (; end < source.length; end += 1) {
      const c = source[end];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (depth === 0 && source.startsWith('/>', end)) break;
    }
    found.push(source.slice(start, end));
  }
  return found;
}

test('a route that sets header items on one return path sets them on all (Android keeps the last headerRight)', () => {
  // HeaderActions only writes headerRight/headerLeft when given `right`/`left`, so a return path
  // without them would keep the previous view's buttons (a terminal's End terminal on the list).
  const offenders = routes(app).flatMap(path => {
    const props = headerActionsProps(readFileSync(path, 'utf8'));
    return (['right', 'left'] as const)
      .filter(side => {
        const has = props.map(p => new RegExp(`\\s${side}=\\{`).test(p));
        return has.includes(true) && has.includes(false);
      })
      .map(side => `${relative(app, path)} (${side})`);
  });
  assert.deepEqual(offenders, [], `Pass right={[]} / left={[]} on every <HeaderActions> of: ${offenders.join(', ')}`);
});

test('the helper sees every HeaderActions, including ones whose props hold arrow functions', () => {
  const props = headerActionsProps(`<HeaderActions right={[{ onPress: () => go() }]} />\n<HeaderActions />`);
  assert.equal(props.length, 2);
  assert.match(props[0], /right=\{/);
  assert.doesNotMatch(props[1], /right=/);
});
