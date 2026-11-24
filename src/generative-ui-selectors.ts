/** The generative UI surfaces that nest one another; the single list every selector derives from. */
export const GU_CONTAINERS = ['.gu-card', '.gu-tabs', '.gu-accordion', '.gu-callout', '.gu-form', '.gu-flow'] as const;
export const GU_CONTAINER_SELECTOR = `:is(${GU_CONTAINERS.join(',')})`;

/** A custom view drawn inside a dialog, a nested or tight host, or two containers deep. */
export const TIGHT_CUSTOM = [
  `.gu-dialog-host ${GU_CONTAINER_SELECTOR} .gu-custom`,
  '.gu-dialog-host.gu-nested-host .gu-custom',
  '.gu-tight-host .gu-custom',
  `.gu-nested-host ${GU_CONTAINER_SELECTOR} .gu-custom`,
  `${GU_CONTAINER_SELECTOR} ${GU_CONTAINER_SELECTOR} .gu-custom`,
].join(',');

/** Mark every custom view under `root` that sits in a tight context. */
export function markTightCustom(root: ParentNode): void {
  for (const node of root.querySelectorAll('.gu-custom')) node.classList.toggle('gu-tight', node.matches(TIGHT_CUSTOM));
}
