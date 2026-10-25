import './usage-heatmap.css';
import { t } from './i18n.ts';

export interface DailyTokens { date: string; tokens: number; }
interface Day { date: Date; key: string; tokens: number; level: number; }

const MIN_WEEKS = 20, MAX_WEEKS = 53, LEVELS = 4, DAY_MS = 86_400_000;
const count = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const dayLabel = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const monthLabel = new Intl.DateTimeFormat(undefined, { month: 'short' });
const weekdayLabel = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
let instances = 0;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}
function localDay(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getDate() === Number(match[3]) ? date : null;
}
function keyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function addDays(date: Date, days: number): Date { return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days); }
export type HeatmapUnit = 'tokens' | 'prompts';
export interface HeatmapOptions { unit?: HeatmapUnit; label?: string; }
function amountLabel(value: number, unit: HeatmapUnit): string {
  if (!value) return unit === 'tokens' ? t('No tokens') : t('No prompts');
  if (unit === 'prompts') return value === 1 ? t`1 prompt` : t`${count.format(value)} prompts`;
  return t`${count.format(value)} tokens`;
}

/** Totals per local calendar day; malformed or negative buckets from the harness are dropped. */
function totalsByDay(daily: readonly DailyTokens[]): Map<string, number> {
  return daily.reduce((totals, { date, tokens }) => {
    const day = localDay(String(date));
    return day && Number.isFinite(tokens) && tokens >= 0 ? new Map(totals).set(keyOf(day), (totals.get(keyOf(day)) ?? 0) + tokens) : totals;
  }, new Map<string, number>());
}

/** Square-root scale keeps a single heavy day from washing every other day into level 1. */
function levelFor(tokens: number, peak: number): number {
  return tokens > 0 && peak > 0 ? Math.max(1, Math.ceil(LEVELS * Math.sqrt(tokens / peak))) : 0;
}

/** Whole weeks (Sunday first, like a calendar) ending today, reaching back to the oldest bucket within a year. */
export function buildDays(daily: readonly DailyTokens[], today = new Date()): Day[] {
  const totals = totalsByDay(daily);
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const oldest = [...totals.keys()].map(key => localDay(key)!).reduce((min, day) => day < min ? day : min, end);
  const span = Math.ceil((end.getTime() - oldest.getTime()) / DAY_MS / 7) + 1;
  const weeks = Math.min(MAX_WEEKS, Math.max(MIN_WEEKS, span));
  const start = addDays(end, -(end.getDay() + (weeks - 1) * 7));
  const length = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
  const dates = Array.from({ length }, (_, i) => addDays(start, i));
  const peak = Math.max(0, ...dates.map(date => totals.get(keyOf(date)) ?? 0));
  return dates.map(date => { const tokens = totals.get(keyOf(date)) ?? 0; return { date, key: keyOf(date), tokens, level: levelFor(tokens, peak) }; });
}

function monthMarks(days: readonly Day[]): HTMLElement[] {
  const marks: HTMLElement[] = [];
  let lastColumn = -Infinity;
  days.forEach((day, i) => {
    const column = Math.floor(i / 7);
    if (!(i === 0 || day.date.getDate() === 1) || column - lastColumn < 3) return;
    // The first partial month only gets a label when it has room before the next one.
    if (i === 0 && addDays(day.date, 21).getMonth() !== day.date.getMonth()) return;
    const mark = element('span', 'heatmap-month', monthLabel.format(day.date));
    mark.style.gridColumn = String(column + 1); marks.push(mark); lastColumn = column;
  });
  return marks;
}

/** Labels sit outside the scroller, so Mon/Wed/Fri stay put while earlier weeks scroll into view. */
function weekdayColumn(days: readonly Day[]): HTMLElement {
  const column = element('div', 'heatmap-weekdays'); column.setAttribute('aria-hidden', 'true');
  column.append(...[1, 3, 5].map(row => {
    const mark = element('span', 'heatmap-weekday', weekdayLabel.format(days[row].date));
    mark.style.gridRow = String(row + 2); return mark;
  }));
  return column;
}

function legend(): HTMLElement {
  const scale = element('span', 'heatmap-legend'); scale.setAttribute('aria-hidden', 'true');
  scale.append(element('span', '', t('Less')), ...Array.from({ length: LEVELS + 1 }, (_, level) => {
    const swatch = element('i', 'heatmap-cell'); swatch.dataset.level = String(level); return swatch;
  }), element('span', '', t('More')));
  return scale;
}

function summary(days: readonly Day[], unit: HeatmapUnit): string {
  const active = days.filter(day => day.tokens > 0);
  const total = active.reduce((sum, day) => sum + day.tokens, 0);
  const weeks = Math.ceil(days.length / 7);
  const period = weeks >= MAX_WEEKS ? t('past year') : t`past ${Math.round(weeks / 4.345)} months`;
  const totalText = unit === 'tokens' ? t`${compact.format(total)} tokens` : t`${compact.format(total)} prompts`;
  const activeText = active.length === 1 ? t`1 active day` : t`${active.length} active days`;
  return `${totalText} · ${activeText} · ${period}`;
}

function cells(days: readonly Day[], prefix: string, unit: HeatmapUnit): HTMLElement[] {
  return days.map((day, i) => {
    const cell = element('span', 'heatmap-cell');
    cell.id = `${prefix}-${day.key}`; cell.dataset.index = String(i); cell.dataset.level = String(day.level);
    cell.setAttribute('role', 'option'); cell.setAttribute('aria-selected', 'false');
    cell.setAttribute('aria-label', `${dayLabel.format(day.date)}: ${amountLabel(day.tokens, unit)}`);
    cell.style.gridArea = `${(i % 7) + 2} / ${Math.floor(i / 7) + 1}`;
    return cell;
  });
}

const KEY_STEPS: Record<string, number> = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 };

/** A calendar heatmap of daily token use. One tab stop; arrows move by day and week, hover previews. */
export function usageHeatmap(daily: readonly DailyTokens[], { unit = 'tokens', label = t('Daily token use') }: HeatmapOptions = {}): HTMLElement {
  const days = buildDays(daily);
  const prefix = `heatmap-${++instances}`;
  const section = element('section', 'command-daily usage-heatmap'); section.setAttribute('aria-labelledby', `${prefix}-title`);
  const heading = element('header', 'heatmap-heading'); const title = element('h3', '', t('Activity')); title.id = `${prefix}-title`;
  heading.append(title, element('span', 'heatmap-summary', summary(days, unit)));
  const body = element('div', 'heatmap-body'); body.style.setProperty('--weeks', String(Math.ceil(days.length / 7)));
  const scroller = element('div', 'heatmap-scroll');
  const grid = element('div', 'heatmap');
  grid.setAttribute('role', 'listbox'); grid.setAttribute('aria-label', label); grid.tabIndex = 0;
  const dayCells = cells(days, prefix, unit);
  grid.append(...monthMarks(days), ...dayCells);
  scroller.append(grid); body.append(weekdayColumn(days), scroller);
  // Fade the leading edge only while earlier weeks are hidden behind it; whenever the panel resizes, return to the present.
  const edge = () => { scroller.classList.toggle('is-scrolled', scroller.scrollLeft > 1); };
  scroller.addEventListener('scroll', edge, { passive: true });
  new ResizeObserver(() => { scroller.scrollLeft = scroller.scrollWidth; edge(); }).observe(scroller);
  const readout = element('span', 'heatmap-readout'); readout.setAttribute('aria-hidden', 'true');
  const footer = element('footer', 'heatmap-footer'); footer.append(readout, legend());
  section.append(heading, body, footer);

  const lastActive = days.reduce((found, day, i) => day.tokens > 0 ? i : found, days.length - 1);
  let selected = -1;
  const show = (index: number) => {
    const day = days[index];
    readout.replaceChildren(element('strong', '', amountLabel(day.tokens, unit)), element('span', '', dayLabel.format(day.date)));
  };
  const select = (index: number) => {
    const next = Math.max(0, Math.min(days.length - 1, index));
    dayCells[selected]?.setAttribute('aria-selected', 'false');
    dayCells[next].setAttribute('aria-selected', 'true'); grid.setAttribute('aria-activedescendant', dayCells[next].id);
    selected = next; show(next);
    if (section.isConnected) dayCells[next].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  const indexOf = (target: EventTarget | null) => target instanceof HTMLElement && target.dataset.index ? Number(target.dataset.index) : null;
  grid.addEventListener('pointerover', event => { const index = indexOf(event.target); if (index !== null) show(index); });
  grid.addEventListener('pointerleave', () => show(selected));
  grid.addEventListener('pointerdown', event => { const index = indexOf(event.target); if (index !== null) select(index); });
  grid.addEventListener('keydown', event => {
    const step = KEY_STEPS[event.key];
    const target = step !== undefined ? selected + step : event.key === 'Home' ? 0 : event.key === 'End' ? days.length - 1 : null;
    if (target === null) return;
    event.preventDefault(); select(target);
  });
  select(lastActive);
  return section;
}
