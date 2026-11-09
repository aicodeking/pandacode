export type WebUiAction =
  | { action: 'queue-resume'; sessionId: string }
  | { action: 'queue-send-now' | 'queue-steer'; sessionId: string; id: string }
  | { action: 'continue-after-limit'; sessionId: string; text?: string };
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
export function validWebUiAction(value: unknown): value is WebUiAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  if (!identifier(action.sessionId)) return false;
  const keys = new Set(['action', 'sessionId']);
  if (action.action === 'queue-send-now' || action.action === 'queue-steer') {
    if (!identifier(action.id)) return false; keys.add('id');
  } else if (action.action === 'continue-after-limit') {
    keys.add('text');
    if (action.text !== undefined && (typeof action.text !== 'string' || !action.text.trim() || action.text.length > 16384)) return false;
  } else if (action.action !== 'queue-resume') return false;
  return Object.keys(action).every(key => keys.has(key));
}
export interface NativeWebUiAction {
  args: WebUiAction;
  resolve(result: unknown): void;
  reject(error: unknown): void;
}
