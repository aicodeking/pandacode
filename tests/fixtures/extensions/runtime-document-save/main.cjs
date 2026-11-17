// R0902 fixture service: a formatter that rewrites a .sql file as the host saves it. It runs for every matching host
// save (the built-in editor, a package editor, an auto-save), not only inside this package's own editor. A handler that
// throws or is slow is skipped by the host: saving always works and the buffer is never lost.
const panda = require('pandacode');

panda.hooks.on('save.before', ({ text }) => {
  const formatted = text.replace(/\s+/g, ' ').replace(/\bselect\b/gi, 'SELECT').trim();
  return formatted === text ? undefined : { text: formatted.endsWith(';') ? formatted : formatted + ';' };
});
