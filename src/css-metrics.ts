export type MeasuredCssToken = '--type-caption' | '--mono-size' | '--ds-control-radius';

/** Resolve CSS lengths (including rem and calc) in the caller's token scope. */
export function measureTokenPx(token: MeasuredCssToken, fallback: number, host?: HTMLElement | null): number {
  if (typeof document === 'undefined') return fallback;
  const parent = host ?? document.body;
  if (!parent) return fallback;
  const probe = document.createElement('span');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  switch (token) {
    case '--type-caption':
      probe.style.fontSize = 'var(--type-caption)';
      probe.style.lineHeight = 'var(--type-caption-leading)';
      break;
    case '--mono-size':
      probe.style.fontFamily = 'var(--mono)';
      probe.style.fontSize = 'var(--mono-size)';
      probe.style.lineHeight = 'var(--leading-code)';
      break;
    case '--ds-control-radius':
      probe.style.borderRadius = 'var(--ds-control-radius)';
      break;
  }
  try {
    parent.append(probe);
    const style = getComputedStyle(probe);
    const px = parseFloat(token === '--ds-control-radius' ? style.borderTopLeftRadius : style.fontSize);
    return Number.isFinite(px) && px > 0 ? px : fallback;
  } finally {
    probe.remove();
  }
}
