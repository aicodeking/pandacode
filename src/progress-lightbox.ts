import { escape, icon } from './dom';
import { legend, linkMarks } from './progress-marks';
import { lazyThumbs } from './progress-media';
import { play, still } from './progress-motion';
import type { Snapshot } from './progress-pip';

/* The large view of one iteration: a modal <dialog> with the annotated image (numbered
 * badges, like the PiP), the note and a legend beside it, and prev / filmstrip / next below.
 * Hovering or focusing a legend row lights its mark and shows its label on the image.
 * Esc closes with a short exit; arrow keys step; once closing it takes no more input. */

export type LightboxHost = {
  snaps(): Snapshot[];
  index(): number;
  go(index: number): void;
  thumb(id: string): Promise<string>;
  /** Draw the current iteration into the lightbox stage. */
  paint(stage: HTMLElement, direction: number): void;
  ago(at: number): string;
  /** Opened with the pointer: focus the dialog itself rather than ringing the close button. */
  fromPointer: boolean;
  closed(): void;
};
export type Lightbox = { update(direction: number): void; close(): void };
export const IDEA = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1.1 2V17h5v-1.2c.1-.8.5-1.5 1.1-2A6 6 0 0 0 12 3Z"/></svg>';

export function openLightbox(host: LightboxHost): Lightbox {
  const dialog = document.createElement('dialog');
  dialog.className = 'pp-lightbox';
  dialog.tabIndex = -1;
  dialog.innerHTML = `<div class="pp-lb-plate">
    <header class="pp-lb-head"><div class="pp-lb-titles"></div><button type="button" class="pp-icon pp-lb-button" data-lb="close" aria-label="Close large view" title="Close (Esc)">${icon('close')}</button></header>
    <div class="pp-lb-body"><figure class="pp-stage pp-lb-stage"><div class="pp-stage-error" hidden></div></figure><aside class="pp-lb-side"><p class="pp-note"></p><div class="pp-lb-legend"></div></aside></div>
    <footer class="pp-lb-foot">
      <button type="button" class="pp-icon pp-lb-button" data-lb="prev" aria-label="Previous iteration">${icon('back')}</button>
      <div class="pp-lb-strip" role="group" aria-label="Iterations"><div class="pp-lb-strip-inner"></div></div>
      <button type="button" class="pp-icon pp-lb-button" data-lb="next" aria-label="Next iteration">${icon('forward')}</button>
    </footer></div>`;
  document.body.append(dialog);
  const q = <T extends HTMLElement = HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  const strip = q('.pp-lb-strip'), inner = q('.pp-lb-strip-inner');
  inner.innerHTML = host.snaps().map((s, i) => `<button type="button" class="pp-thumb${s.kind === 'idea' ? ' is-idea' : ''}" data-lb="thumb" data-index="${i}" aria-label="Iteration ${s.iteration}: ${escape(s.title)}" style="--i:${Math.min(i, 8)}"><img data-thumb="${escape(s.id)}" alt=""><span class="pp-thumb-n" aria-hidden="true">${s.iteration}</span>${s.kind === 'idea' ? `<span class="pp-idea" aria-hidden="true">${IDEA}</span>` : ''}</button>`).join('');
  const observer = lazyThumbs(strip, host.thumb);
  linkMarks(q('.pp-lb-plate'));
  let closing = false;

  function update(direction: number): void {
    const snaps = host.snaps(), index = host.index(), s = snaps[index];
    if (!s) { close(); return; }
    q('.pp-lb-titles').innerHTML = `<p class="pp-lb-count"><strong>Iteration ${s.iteration}</strong> / ${snaps.length}</p><h3 class="pp-lb-title" title="${escape(s.title)}">${escape(s.title)}</h3><p class="pp-meta">${s.kind === 'idea' ? `<span class="pp-tag">${IDEA}Idea sketch</span>` : ''}<span>${host.ago(s.createdAt)}</span></p>`;
    dialog.setAttribute('aria-label', `Iteration ${s.iteration} of ${snaps.length}: ${s.title}`);
    const note = q('.pp-note'); note.textContent = s.note ?? ''; note.hidden = !s.note;
    q('.pp-lb-legend').innerHTML = legend(s.annotations);
    q<HTMLButtonElement>('[data-lb="prev"]').disabled = index === 0;
    q<HTMLButtonElement>('[data-lb="next"]').disabled = index === snaps.length - 1;
    inner.querySelectorAll<HTMLElement>('.pp-thumb').forEach((thumb, i) => {
      if (i === index) { thumb.setAttribute('aria-current', 'step'); thumb.scrollIntoView({ block: 'nearest', inline: 'center' }); } else thumb.removeAttribute('aria-current');
    });
    host.paint(q('.pp-lb-stage'), direction);
  }
  function close(): void {
    if (closing) return;
    closing = true;
    dialog.classList.add('is-closing');
    observer.disconnect();
    const done = () => { dialog.close(); dialog.remove(); host.closed(); };
    const exit = play(q('.pp-lb-plate'), [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.97) translateY(6px)' }], 200, { fill: 'forwards', easing: 'cubic-bezier(.4,0,1,1)' });
    if (!still()) try { dialog.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards', pseudoElement: '::backdrop' }); } catch { /* no ::backdrop animation here */ }
    if (exit) exit.finished.then(done, done); else done();
  }

  dialog.addEventListener('click', event => {
    if (closing) return;
    const target = (event.target as Element).closest<HTMLElement>('[data-lb]');
    if (event.target === dialog || target?.dataset.lb === 'close') close();
    else if (target?.dataset.lb === 'prev') host.go(host.index() - 1);
    else if (target?.dataset.lb === 'next') host.go(host.index() + 1);
    else if (target?.dataset.lb === 'thumb') host.go(Number(target.dataset.index));
  });
  dialog.addEventListener('keydown', event => {
    // Esc is ours here: it must never reach the app's "Esc stops the agent".
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (closing) event.preventDefault();
    else if (event.key === 'ArrowLeft') { event.preventDefault(); host.go(host.index() - 1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); host.go(host.index() + 1); }
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.showModal();
  if (host.fromPointer) dialog.focus(); else q('[data-lb="close"]').focus();
  play(q('.pp-lb-plate'), [{ opacity: 0, transform: 'scale(.95) translateY(10px)', filter: 'blur(4px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], 380);
  inner.querySelectorAll('.pp-thumb').forEach((thumb, i) => play(thumb, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], 320, { delay: 120 + Math.min(i, 8) * 35 }));
  update(0);
  return { update, close };
}
