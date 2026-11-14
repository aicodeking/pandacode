import type { FileEntry } from './types';

type Args = Record<string, any>;
const initial: Record<string, string[]> = {
  '': ['src/', 'public/', 'index.html', 'package.json', 'README.md', 'tsconfig.json', 'report.pdf', 'proposal.docx', 'budget.xlsx', 'screenshot.png'],
  src: ['components/', 'lib/', 'main.ts', 'style.css'],
  public: ['favicon.svg'],
  'src/components': ['search.ts', 'search.test.ts'],
  'src/lib': ['search.ts', 'search.test.ts'],
};
export function createPreviewFileExplorer() {
  const workspaces = new Map<string, { files: Map<string, FileEntry>; contents: Map<string, string>; revisions: Map<string, number> }>();
  const state = (args: Args) => {
    const key = `${args.projectId}:${args.sessionId ?? ''}`;
    let value = workspaces.get(key);
    if (!value) {
      const files = new Map<string, FileEntry>();
      for (const [parent, names] of Object.entries(initial)) for (const name of names) {
        const path = [parent, name.replace(/\/$/, '')].filter(Boolean).join('/');
        files.set(path, { path, name: path.split('/').pop()!, isDir: name.endsWith('/') });
      }
      value = { files, contents: new Map(), revisions: new Map() }; workspaces.set(key, value);
    }
    return value;
  };
  const requireFile = (args: Args) => { const value = state(args); if (!value.files.has(args.path)) throw new Error('File no longer exists.'); return value; };
  return {
    list(args: Args): FileEntry[] {
      const value = state(args), path = args.path || '';
      if (path && !value.files.get(path)?.isDir) throw new Error('Folder no longer exists.');
      return [...value.files.values()].filter(entry => entry.path.split('/').slice(0, -1).join('/') === path).sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    },
    read(args: Args, fallback: string): string { return requireFile(args).contents.get(args.path) ?? fallback; },
    stamp(args: Args): string { return String(requireFile(args).revisions.get(args.path) ?? 0); },
    save(args: Args, original: string): void {
      const value = requireFile(args);
      if ((value.contents.get(args.path) ?? original) !== args.expected) throw new Error('File changed on disk. Copy your edits, then reload before saving.');
      if (new TextEncoder().encode(args.content).length > 128 * 1024) throw new Error('Text files must be UTF-8 and no larger than 128 KiB.');
      value.contents.set(args.path, args.content); value.revisions.set(args.path, (value.revisions.get(args.path) ?? 0) + 1);
    },
    manage(args: Args, root: string): string {
      if (args.action === 'path') return [root, args.path].filter(Boolean).join('/');
      const value = state(args), path: string = args.path;
      if (!path || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || part.includes(':') || part.includes('\0'))) throw new Error('Choose a file or folder inside the project.');
      const parent = path.split('/').slice(0, -1).join('/');
      if (parent && !value.files.get(parent)?.isDir) throw new Error('Folder no longer exists.');
      if (args.action === 'new-file' || args.action === 'new-folder') {
        if (value.files.has(path)) throw new Error('A file or folder with that name already exists.');
        value.files.set(path, { path, name: path.split('/').pop()!, isDir: args.action === 'new-folder' });
        if (args.action === 'new-file') value.contents.set(path, '');
        return path;
      }
      requireFile(args);
      const name = String(args.name ?? '');
      if (args.action === 'rename' && (!name.trim() || /[/\\:\0]/.test(name) || name === '.' || name === '..' || name.toLowerCase() === '.git')) throw new Error('Enter a single file or folder name.');
      const next = [parent, name].filter(Boolean).join('/');
      if (args.action === 'rename' && value.files.has(next)) throw new Error('A file or folder with that name already exists.');
      for (const [old, entry] of [...value.files]) if (old === path || old.startsWith(path + '/')) {
        value.files.delete(old);
        const content = value.contents.get(old); value.contents.delete(old);
        if (args.action === 'rename') {
          const renamed = next + old.slice(path.length);
          value.files.set(renamed, { ...entry, path: renamed, name: renamed.split('/').pop()! });
          if (content !== undefined) value.contents.set(renamed, content);
          value.revisions.set(renamed, (value.revisions.get(old) ?? 0) + 1);
        }
      }
      return args.action === 'rename' ? next : path;
    },
  };
}
