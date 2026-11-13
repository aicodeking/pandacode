export const ERROR_TEXT_LIMIT = 2000;

const clip = (text: string): string => text.length > ERROR_TEXT_LIMIT ? `${text.slice(0, ERROR_TEXT_LIMIT - 1)}…` : text;

/** User-facing text for any thrown or rejected value; never `[object Object]`, JSON or a stack. */
export function errorText(error: unknown, fallback = 'Something went wrong.'): string {
  let text: unknown = error;
  if (error instanceof Error) text = error.message;
  else if (error && typeof error === 'object') {
    const { message, error: inner } = error as { message?: unknown; error?: unknown };
    text = [message, inner].find(v => typeof v === 'string' && v.trim());
  }
  if (typeof text === 'number' || typeof text === 'boolean') return String(text);
  return typeof text === 'string' && text.trim() ? clip(text.trim()) : fallback;
}
