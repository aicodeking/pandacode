// Sound: two small files from the panel folder. The browser allows sound only after the user pressed a key or clicked, so
// nothing is created or played before `unlock` runs from such an event; until then `play` is a quiet no-op.
export function createAudio(base) {
  let enabled = false;
  let unlocked = false;
  const clips = {};
  const load = name => {
    const clip = new Audio(new URL(`${name}.wav`, base).href);
    clip.preload = 'auto';
    return clip;
  };
  return {
    get enabled() { return enabled; },
    get unlocked() { return unlocked; },
    set enabled(value) { enabled = value === true; },
    /** Call from a key or click handler. */
    unlock() {
      if (unlocked) return;
      unlocked = true;
      clips.point = load('point');
      clips.over = load('over');
    },
    play(name) {
      if (!enabled || !unlocked || !clips[name]) return false;
      try { clips[name].currentTime = 0; void clips[name].play().catch(() => {}); return true; } catch { return false; }
    },
  };
}
