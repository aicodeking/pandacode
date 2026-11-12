/** Explicit synthetic transport controls; imported only by the browser preview hook. */
import { setDialogCallbacks } from './dialogs';
import { declarativeDialogCallbacks, type DialogContext, type DialogValues } from './dialog-state';

export function installPreviewDialogTransport() {
  const calls: { id: number; kind: 'options' | 'validate'; query?: string; field?: string; context: DialogContext; values?: DialogValues; aborted: boolean }[] = [];
  const pending = new Map<number, () => void>();
  const transport = { calls, holdOptions: false, holdValidation: false, failOptions: false, failValidation: false,
    release(id: number) { pending.get(id)?.(); pending.delete(id); },
    releaseAll() { pending.forEach(release => release()); pending.clear(); },
  };
  setDialogCallbacks({
    async options(field, query, context, signal) {
      const call = { id: calls.length, kind: 'options' as const, field: field.id, query, context, aborted: signal.aborted }; calls.push(call);
      signal.addEventListener('abort', () => { call.aborted = true; }, { once: true });
      if (transport.holdOptions) await new Promise<void>(resolve => { pending.set(call.id, resolve); });
      if (transport.failOptions) throw new Error('Synthetic option failure.');
      return declarativeDialogCallbacks.options(field, query, context, signal);
    },
    async validate(values, context, signal) {
      const call = { id: calls.length, kind: 'validate' as const, values, context, aborted: signal.aborted }; calls.push(call);
      signal.addEventListener('abort', () => { call.aborted = true; }, { once: true });
      if (transport.holdValidation) await new Promise<void>(resolve => { pending.set(call.id, resolve); });
      if (transport.failValidation) throw new Error('Synthetic validation failure.');
      return {};
    },
  });
  return transport;
}
