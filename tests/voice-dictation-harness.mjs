// Shared fake DOM and controllers for the voice-dictation-*.test.mjs suites.

/** Just enough DOM for the controller: it builds its pill from createElement and listens on document. */
export function fakeDom({ context = true } = {}) {
  const listeners = {}, timers = new Map(), timeouts = new Map(), frames = new Map(), draws = [], observers = [];
  let frameId = 0;
  const windowListeners = {}, mediaQueries = new Map(), drawStats = { paths: 0, fills: 0, gradients: [] };
  let foreground = null;
  const element = () => ({
    offsetWidth: 300, offsetHeight: 60, offsetLeft: 0, offsetTop: 0,
    dataset: {}, attributes: {}, style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } }, hidden: false, children: [], textContent: '', innerHTML: '', isConnected: true,
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    removeAttribute(name) { delete this.attributes[name]; },
    hasAttribute(name) { return name in this.attributes; },
    toggleAttribute(name, on) { if (on) this.attributes[name] = ''; else delete this.attributes[name]; },
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(n => n !== this); this.parentElement = null; }, focus() { document.activeElement = this; },
    contains(node) { return this === node || this.children.some(child => typeof child === 'object' && child.contains?.(node)); },
    querySelector() { return this.children.find(child => child.type === 'button') ?? null; },
    append(...nodes) { for (const node of nodes) { if (!this.children.includes(node)) this.children.push(node); if (typeof node === 'object') node.parentElement = this; } },
    replaceChildren(...nodes) { this.children.length = 0; this.append(...nodes); },
    addEventListener() {}, removeEventListener() {},
    getClientRects: () => [{}], getBoundingClientRect: () => ({ width: 300, height: 60 }), closest: () => null,
    getContext: () => context ? ({ createLinearGradient(...coordinates) { const stops = []; drawStats.gradients.push({ coordinates, stops }); return { addColorStop(...stop) { stops.push(stop); } }; }, setTransform() {}, clearRect() { draws.push([]); }, fillRect() {}, beginPath() { drawStats.paths++; }, roundRect(...bar) { draws.at(-1)?.push(bar); }, fill() { drawStats.fills++; } }) : null,
  });
  const mic = element(); mic.dataset.voice = 'toggle';
  globalThis.document = { createElement: element, addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener: (type, fn) => { if (listeners[type] === fn) delete listeners[type]; }, querySelectorAll: selector => selector === '.voice-mic' ? [mic] : [], querySelector: () => foreground, activeElement: null };
  const motion = { matches: false, addEventListener() {}, removeEventListener() {} };
  globalThis.ResizeObserver = class { constructor(callback) { observers.push(callback); } observe() {} disconnect() {} };
  globalThis.MutationObserver = class { constructor(callback) { (globalThis.__mutationCallbacks ??= []).push(callback); } observe() {} disconnect() {} };
  globalThis.getComputedStyle = () => ({ color: 'rgb(0, 0, 0)', paddingLeft: '16px', paddingRight: '8px', paddingTop: '12px', paddingBottom: '6px', getPropertyValue: () => 'rgb(0, 0, 0)' });
  globalThis.window = { setTimeout(fn) { const id = timeouts.size + 1; timeouts.set(id, fn); return id; }, clearTimeout(id) { timeouts.delete(id); }, devicePixelRatio: 1, matchMedia(query) { if (query.includes('reduced-motion')) return motion; const callbacks = new Set(); const media = { matches: false, callbacks, addEventListener(type, fn) { callbacks.add(fn); }, removeEventListener(type, fn) { callbacks.delete(fn); } }; mediaQueries.set(query, media); return media; }, requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame(id) { frames.delete(id); }, addEventListener(type, fn) { windowListeners[type] = fn; }, removeEventListener(type, fn) { if (windowListeners[type] === fn) delete windowListeners[type]; }, setInterval(fn) { timers.set(timers.size + 1, fn); return timers.size; }, clearInterval(id) { timers.delete(id); } };
  globalThis.HTMLTextAreaElement ??= class { get value() { return this._value ?? ''; } set value(next) { this._value = next; } };
  const form = element(), inputs = {};
  let inputArea = element();
  const prompt = Object.assign(new HTMLTextAreaElement(), element(), {
    selectionStart: 0, selectionEnd: 0, disabled: false, readOnly: false,
    addEventListener(type, fn) { inputs[type] = fn; },
    closest: selector => selector === 'form' ? form : selector === '.composer-input' ? inputArea : null,
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    setRangeText(text, start, end) { this._value = this.value.slice(0, start) + text + this.value.slice(end); },
    dispatchEvent(event) { inputs[event.type]?.(event); },
  });
  form.contains = node => node === form || node === prompt || node === mic || form.children.some(child => child.contains(node));
  const click = voice => listeners.click({ target: { closest: () => ({ dataset: { voice } }) }, preventDefault() {} });
  const key = (key, options = {}) => {
    const event = { key, target: document.activeElement, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...options };
    listeners[options.type ?? 'keydown'](event); return event;
  };
  return { timeouts, selection: () => listeners.selectionchange?.(), resize: () => observers.forEach(callback => callback([])), prompt, form, inputArea, drawStats, mediaQueries, density(ratio) { const media = mediaQueries.get(`(resolution: ${window.devicePixelRatio}dppx)`); window.devicePixelRatio = ratio; media?.callbacks.forEach(fn => fn()); }, windowEvent(type) { windowListeners[type]?.(); }, submit() { const event = { target: form, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; } }; listeners.submit?.(event); return event; }, replaceInputArea() { inputArea = element(); return inputArea; }, click, key, mic, timers, frames, draws, frame(now) { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(now)); }, visibility(hidden) { document.hidden = hidden; listeners.visibilitychange?.(); }, element, motion, foreground: value => { foreground = value; }, input: () => inputs.input?.(), composition: type => inputs[type]?.() };
}

export const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };

export const settle = () => new Promise(r => setTimeout(r, 0));

export async function controller(overrides = {}) {
  const { createVoiceDictation } = await import('../src/voice-dictation.ts');
  const dom = fakeDom({ context: overrides.canvasContext !== false }), calls = [], announcements = [], result = deferred(), retry = deferred();
  let receive, settingsOpened = 0;
  const config = { selectedProfileId: 'p', profiles: [{ id: 'p', provider: 'custom', name: 'Local', model: 'whisper-1', endpoint: 'http://127.0.0.1:8080/inference', hasKey: false }], limits: { maxSeconds: 120 } };
  const host = {
    call(command, args) {
      calls.push([command, args]);
      if (command === 'voice_configuration') return Promise.resolve(config);
      if (command === 'voice_start') return Promise.resolve({ captureId: 'c' });
      if (command === 'voice_stop') return result.promise;
      if (command === 'voice_retry') return retry.promise;
      return Promise.resolve();
    },
    subscribe(fn) { receive = fn; return Promise.resolve(() => {}); }, thread: () => 't',
    settings() { settingsOpened++; }, isImeKey: event => event.isComposing || event.keyCode === 229,
    enter() {}, describePrompt: () => 'Enter to send', announce: text => announcements.push(text), ...overrides,
  };
  const voice = createVoiceDictation(host); voice.bind(dom.prompt);
  return { ...dom, voice, calls, announcements, config, result, retry, pill: voice.pill.element, settingsOpened: () => settingsOpened,
    async start() { dom.mic.focus(); dom.click('toggle'); await settle(); },
    event(event) { receive({ requestId: calls.find(([name]) => name === 'voice_start')[1].requestId, captureId: 'c', elapsedMs: 1000, level: 0.3, ...event }); },
  };
}

/** A controller whose configuration reads can be made to fail and whose native Start can be held. */
export async function flakyConfigurationController({ holdStart = false } = {}) {
  const calls = [], result = deferred(), started = deferred(), state = { failReads: false };
  const h = await controller({ call(command, args) {
    calls.push([command, args]);
    if (command === 'voice_configuration') {
      return state.failReads ? Promise.reject(new Error('Speech configuration is temporarily unavailable.')) : Promise.resolve(h.config);
    }
    if (command === 'voice_start') return holdStart ? started.promise : Promise.resolve({ captureId: 'c' });
    if (command === 'voice_stop') return result.promise;
    return Promise.resolve();
  } });
  return { ...h, calls, result, started, state };
}

export async function threadController() {
  let thread = 't';
  const h = await controller({ thread: () => thread, threadTitle: id => id === 't' ? 'Ship search' : 'Other' });
  return { ...h, go(id, prompt) { thread = id; h.voice.bind(prompt); } };
}

/** A controller whose preferences, catalog and Stop result the test controls. */
export async function routedController({ destination = { profileId: 'p' }, shortcutMode = 'auto', catalog } = {}) {
  const calls = [], result = deferred(), started = deferred(), state = { holdStart: false }; let h;
  const prefs = { destination, deviceName: null, shortcutMode, language: 'auto', unloadAfter: 'min_5', selectedModel: 'm1' };
  const localCatalog = catalog ?? { platformSupported: true, vad: { state: 'installed' }, models: [{ id: 'm1', name: 'Parakeet', state: 'installed', active: true }] };
  h = await controller({ call(command, args) {
    calls.push([command, args]);
    if (command === 'voice_configuration') return Promise.resolve(h?.config);
    if (command === 'voice_preferences') return Promise.resolve(structuredClone(prefs));
    if (command === 'voice_local_catalog') return Promise.resolve(structuredClone(localCatalog));
    if (command === 'voice_start') return state.holdStart ? started.promise : Promise.resolve({ captureId: 'c' });
    if (command === 'voice_stop') return result.promise;
    return Promise.resolve();
  } });
  await settle();
  const shortcut = (type, timeStamp, options = {}) => h.key('d', { type, metaKey: true, shiftKey: true, timeStamp, ...options });
  return { ...h, calls, result, started, state, prefs, shortcut,
    async refresh() { h.windowEvent('voice-configuration-changed'); await settle(); await settle(); } };
}
