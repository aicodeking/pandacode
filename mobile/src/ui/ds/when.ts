// When something last happened, as a person says it: today and yesterday by name, else the date.
const DAY_MS = 24 * 60 * 60 * 1000;

const startOfDay = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();

export function lastActiveLabel(at: number, now: number = Date.now()): string {
  const time = new Date(at).toLocaleTimeString([], { timeStyle: 'short' });
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(new Date(at))) / DAY_MS);
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Yesterday at ${time}`;
  return new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}
