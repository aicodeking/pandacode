// A model id as a person reads it, for when the host's model list (with real names) isn't loaded:
// `opus` → Opus, `gpt-5.1-codex` → GPT-5.1 Codex, `claude-opus-4-8` → Claude Opus 4.8.
const ACRONYMS = new Set(['gpt', 'glm', 'ai']);

export function modelLabel(id: string): string {
  const words = id.split(/[-_\s]+/).filter(Boolean).reduce<string[]>((all, part) => {
    // Version parts join with a dot, whatever the word before them.
    if (/^\d+(\.\d+)*$/.test(part) && /\d$/.test(all.at(-1) ?? '')) return [...all.slice(0, -1), `${all.at(-1)}.${part}`];
    const word = ACRONYMS.has(part.toLowerCase()) ? part.toUpperCase() : `${part[0].toUpperCase()}${part.slice(1)}`;
    return [...all, word];
  }, []);
  // The first version number stays attached to an acronym: GPT-5.1, GLM-5.
  return words.join(' ').replace(/\b(GPT|GLM) (\d)/, '$1-$2');
}
