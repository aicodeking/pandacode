import { call } from './bridge';
import { escape, icon } from './dom';
import { mountDiffViewer, type DiffViewerController } from './diff-viewer';
import type { Session } from './types';
import './checkpoints.css';

export interface CheckpointComparison { patch: string; files: string[]; skipped: string[]; truncated: boolean; token: string | null }
interface Checkpoint { messageId: number; createdAt: number; skipped: number }
interface DialogOptions {
  modal: (title: string, body: string, cls?: string) => HTMLDialogElement;
  close: () => void;
}

export async function showCheckpoints(sessionId: string, options: DialogOptions & { rewind: (messageId: number) => Promise<void>; compare: (messageId: number) => Promise<void> }): Promise<void> {
  const dialog = options.modal('Checkpoints', '<p>Saved before each turn. Choose a checkpoint to preview the files and rewind.</p><div class="checkpoint-list" aria-live="polite">Loading checkpoints…</div><p class="checkpoint-error" role="alert" hidden></p><div class="dialog-footer"><button class="secondary-button" data-action="close-dialog">Close</button><button class="secondary-button" data-checkpoint-compare disabled>Compare turns</button></div>', 'checkpoint-dialog');
  const host = dialog.querySelector<HTMLElement>('.checkpoint-list')!;
  const compare = dialog.querySelector<HTMLButtonElement>('[data-checkpoint-compare]')!;
  const error = dialog.querySelector<HTMLElement>('.checkpoint-error')!;
  const active = () => dialog.open && host.isConnected;
  let busy = false;
  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    busy = true; error.hidden = true;
    try { await action(); }
    catch (value) { if (active()) { error.textContent = String(value); error.hidden = false; } }
    finally { busy = false; }
  };
  try {
    const checkpoints = await call<Checkpoint[]>('list_checkpoints', { sessionId });
    if (!active()) return;
    if (!checkpoints.length) { host.textContent = 'No checkpoints yet. A checkpoint is saved when an agent starts a turn in a local Git project. Older messages may not have one.'; return; }
    host.innerHTML = checkpoints.map((checkpoint, index) => `<div class="ds-row checkpoint-row"><span class="ds-row-main"><span class="ds-row-title">Checkpoint ${index + 1}</span><time class="ds-row-sub" datetime="${new Date(checkpoint.createdAt).toISOString()}">${escape(new Date(checkpoint.createdAt).toLocaleString())}</time></span><button class="ds-btn" data-checkpoint-rewind="${checkpoint.messageId}" aria-label="Rewind to checkpoint ${index + 1}">${icon('undo')}Rewind…</button></div>`).reverse().join('');
    host.onclick = event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-checkpoint-rewind]');
      if (button) void perform(() => options.rewind(Number(button.dataset.checkpointRewind)));
    };
    compare.disabled = checkpoints.length < 2;
    compare.onclick = () => void perform(() => options.compare(checkpoints.at(-1)!.messageId));
  } catch (value) { if (active()) { host.textContent = ''; error.textContent = String(value); error.hidden = false; } }
}

export async function showRewind(sessionId: string, messageId: number, options: DialogOptions & { restored: (task: Session) => Promise<void> }): Promise<void> {
  const dialog = options.modal('Rewind to here', `<p role="note">Restore files to before this message and open a new conversation with your prompt ready to edit. Later edits, including your own and other tasks’ edits, will be overwritten. The original conversation stays saved.</p><div class="checkpoint-review" aria-live="polite">Preparing restore preview…</div><p class="checkpoint-error" role="alert" hidden></p><div class="dialog-footer"><button class="secondary-button" data-action="close-dialog">Cancel</button><button class="secondary-button" data-checkpoint-reload hidden>Refresh preview</button><button class="primary-button" data-checkpoint-restore disabled>Restore files and fork</button></div>`, 'checkpoint-dialog');
  const host = dialog.querySelector<HTMLElement>('.checkpoint-review')!;
  const error = dialog.querySelector<HTMLElement>('.checkpoint-error')!;
  const submit = dialog.querySelector<HTMLButtonElement>('[data-checkpoint-restore]')!;
  const reload = dialog.querySelector<HTMLButtonElement>('[data-checkpoint-reload]')!;
  let current: CheckpointComparison | undefined, viewer: DiffViewerController | undefined, busy = false;
  const active = () => dialog.open && host.isConnected;
  const discard = () => { if (current?.token) void call('discard_rewind', { token: current.token }).catch(() => {}); current = undefined; };
  dialog.addEventListener('close', () => { viewer?.dispose(); discard(); }, { once: true });
  const fail = (value: unknown) => { error.textContent = String(value); error.hidden = false; reload.hidden = false; submit.disabled = true; };
  const load = async () => {
    discard(); viewer?.dispose(); submit.disabled = true; reload.hidden = true; error.hidden = true;
    host.textContent = 'Preparing restore preview…';
    try {
      const result = await call<CheckpointComparison>('preview_rewind', { sessionId, messageId });
      if (!active()) { if (result.token) void call('discard_rewind', { token: result.token }).catch(() => {}); return; }
      current = result;
      host.innerHTML = `<p>${result.files.length ? `${result.files.length} ${result.files.length === 1 ? 'file will' : 'files will'} change.` : 'Files already match this checkpoint.'}</p>${result.files.length ? `<details><summary>Files to restore</summary><ul>${result.files.map(path => `<li>${escape(path)}</li>`).join('')}</ul></details>` : ''}${result.skipped.length ? `<details><summary>${result.skipped.length} excluded ${result.skipped.length === 1 ? 'path will' : 'paths will'} stay untouched</summary><ul>${result.skipped.map(path => `<li>${escape(path)}</li>`).join('')}</ul></details>` : ''}<p class="checkpoint-limits">Ignored files, submodules, and files over 8 MiB are excluded. Each capture holds up to 64 MiB across 10,000 paths. Checkpoints expire after 30 days.</p>${result.truncated ? '<p role="note">The diff preview is shortened. Restore includes every listed file.</p>' : ''}<div class="checkpoint-diff"></div>`;
      if (result.patch) viewer = mountDiffViewer(host.querySelector('.checkpoint-diff')!, { patch: result.patch, truncated: result.truncated });
      submit.disabled = !result.token;
    } catch (value) { if (active()) { host.textContent = ''; fail(value); } }
  };
  reload.onclick = () => { if (!busy) void load(); };
  submit.onclick = async () => {
    if (busy || !current?.token) return;
    busy = true; submit.disabled = true; submit.textContent = 'Restoring…'; reload.hidden = true;
    try {
      const task = await call<Session>('rewind_checkpoint', { sessionId, messageId, token: current.token });
      current = undefined;
      if (active()) options.close();
      await options.restored(task);
    } catch (value) { if (active()) fail(value); }
    finally { busy = false; submit.textContent = 'Restore files and fork'; }
  };
  await load();
}

export async function showCheckpointComparison(sessionId: string, messageId: number, options: DialogOptions & { compared: (result: CheckpointComparison, label: string) => void }): Promise<void> {
  const dialog = options.modal('Compare turns', '<p>Compare files saved before two user messages.</p><div class="checkpoint-picker" role="status">Loading checkpoints…</div>', 'checkpoint-dialog');
  const host = dialog.querySelector<HTMLElement>('.checkpoint-picker')!;
  let checkpoints: Checkpoint[];
  try { checkpoints = await call<Checkpoint[]>('list_checkpoints', { sessionId }); }
  catch (error) { if (host.isConnected) { host.setAttribute('role', 'alert'); host.textContent = String(error); } return; }
  if (!dialog.open || !host.isConnected) return;
  if (checkpoints.length < 2) { host.textContent = 'Two saved checkpoints are needed to compare turns. Older messages may not have a checkpoint.'; return; }
  const label = (checkpoint: Checkpoint, index: number) => `Checkpoint ${index + 1} · ${new Date(checkpoint.createdAt).toLocaleString()}`;
  const optionsHtml = checkpoints.map((checkpoint, index) => `<option value="${checkpoint.messageId}">${escape(label(checkpoint, index))}</option>`).join('');
  host.innerHTML = `<label class="field-label" for="checkpoint-from">From</label><select id="checkpoint-from">${optionsHtml}</select><label class="field-label" for="checkpoint-to">To</label><select id="checkpoint-to">${optionsHtml}</select><p class="checkpoint-error" role="alert" hidden></p><div class="dialog-footer"><button class="secondary-button" data-action="close-dialog">Cancel</button><button class="primary-button" data-checkpoint-compare>Compare in inspector</button></div>`;
  const from = host.querySelector<HTMLSelectElement>('#checkpoint-from')!, to = host.querySelector<HTMLSelectElement>('#checkpoint-to')!;
  from.value = String(checkpoints.some(checkpoint => checkpoint.messageId === messageId) ? messageId : checkpoints[0].messageId);
  to.value = String(checkpoints.at(-1)!.messageId);
  if (to.value === from.value) from.value = String(checkpoints[0].messageId);
  const submit = host.querySelector<HTMLButtonElement>('[data-checkpoint-compare]')!;
  const update = () => { submit.disabled = from.value === to.value; };
  from.onchange = to.onchange = update;
  submit.onclick = async () => {
    submit.disabled = true;
    const error = host.querySelector<HTMLElement>('.checkpoint-error')!; error.hidden = true;
    const fromMessage = Number(from.value), toMessage = Number(to.value);
    try {
      const result = await call<CheckpointComparison>('compare_checkpoints', { sessionId, fromMessage, toMessage });
      if (!dialog.open || !host.isConnected) return;
      options.close();
      options.compared(result, `Checkpoint ${checkpoints.findIndex(cp => cp.messageId === fromMessage) + 1} → ${checkpoints.findIndex(cp => cp.messageId === toMessage) + 1}`);
    } catch (value) { if (host.isConnected) { error.textContent = String(value); error.hidden = false; } }
    finally { update(); }
  };
  from.focus();
}
