import { call, subscribe } from './bridge';
import { icon } from './dom';

const profilers = {
  onnx: { label: 'ONNX', detail: 'Most recent routed batch: ONNX profiler.' },
  heuristic: { label: 'Keywords', detail: 'Most recent routed batch: keyword heuristic.' },
  mixed: { label: 'Mixed', detail: 'Most recent routed batch: both ONNX and keyword heuristics.' },
} as const;
const empty = { label: '—', detail: 'No routed batch has been reported yet.' };
const history = 'This is history: it does not indicate current readiness or predict the next batch.';
const readinessStates = {
  starting: { label: 'Starting…', note: 'The ONNX profiler is starting; routing uses keywords until it loads.' },
  ready: { label: 'ONNX Ready', note: 'The ONNX profiler is loaded and ready for routing.' },
  unavailable: { label: 'ONNX Unavailable', note: 'The ONNX profiler is unavailable here; routing uses keyword heuristics.' },
  idle: { note: 'The ONNX profiler is idle and not loaded; the label shows the last routed batch.' },
  disabled: { note: 'Panda Router is off, so the profiler is not loaded; the label shows the last routed batch.' },
} as const;
type Readiness = keyof typeof readinessStates;
// Canal nuevo aún sin sobrecarga en bridge.ts (mismo patrón que agents-dock.ts).
const listen = subscribe as unknown as (name: string, callback: (event: unknown) => void) => Promise<() => void>;

function isProfiler(payload: unknown): payload is keyof typeof profilers {
  return typeof payload === 'string' && Object.hasOwn(profilers, payload);
}

function isReadiness(payload: unknown): payload is Readiness {
  return typeof payload === 'string' && Object.hasOwn(readinessStates, payload);
}

export function mountRouterProfilerIndicator(host: HTMLElement | null): void {
  if (!host) return;
  const pill = document.createElement('span');
  pill.id = 'router-profiler-status';
  pill.className = 'ds-chip router-profiler-indicator';
  pill.tabIndex = 0;
  pill.setAttribute('data-tauri-drag-region', 'false');
  pill.setAttribute('role', 'status');
  pill.setAttribute('aria-label', 'Router profiler');
  pill.setAttribute('aria-describedby', 'router-profiler-detail');
  pill.innerHTML = `${icon('merge')}<span data-router-profiler-label aria-hidden="true"><span class="router-profiler-prefix">Router: </span><span data-router-profiler-value></span></span><span id="router-profiler-detail" class="sr-only"></span>`;
  const value = pill.querySelector<HTMLElement>('[data-router-profiler-value]')!;
  const detail = pill.querySelector<HTMLElement>('#router-profiler-detail')!;
  let last: keyof typeof profilers | null = null;
  let readiness: Readiness | null = null;
  const render = () => {
    const state = readiness ? readinessStates[readiness] : null;
    const label = state && 'label' in state ? state.label : last ? profilers[last].label : empty.label;
    const text = [state?.note, last ? profilers[last].detail : empty.detail, history].filter(Boolean).join(' ');
    if (value.textContent !== label) value.textContent = label;
    if (detail.textContent !== text) detail.textContent = text;
    pill.dataset.tip = `Router readiness and the profiler used by the most recent routed batch. ${text}`;
  };
  render();
  host.append(pill);

  // Dos canales independientes: cada uno se suscribe antes de leer y un evento válido gana a la lectura inicial.
  let profilerEvent = false;
  let readinessEvent = false;
  void subscribe('model-routing-profiler', payload => {
    if (!isProfiler(payload)) return;
    profilerEvent = true;
    last = payload;
    render();
  }).then(async () => {
    const initial = await call<unknown>('model_routing_last_profiler');
    if (!profilerEvent && isProfiler(initial)) { last = initial; render(); }
  }).catch(() => undefined);
  void listen('model-routing-profiler-readiness', payload => {
    if (!isReadiness(payload)) return;
    readinessEvent = true;
    readiness = payload;
    render();
  }).then(async () => {
    const initial = await call<unknown>('model_routing_profiler_readiness');
    if (!readinessEvent && isReadiness(initial)) { readiness = initial; render(); }
  }).catch(() => undefined);
}
