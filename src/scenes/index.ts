import { sceneIndex } from './pick';
import type { Scene } from './types';

/** Every `src/scenes/*.ts` that exports `scene` registers itself, sorted by id so the pick is stable. */
const modules = import.meta.glob<{ scene?: Scene }>('./*.ts', { eager: true });
export const SCENES: readonly Scene[] = Object.values(modules).flatMap(module => module.scene ? [module.scene] : [])
  .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const SKY = SCENES.find(scene => scene.id === 'sky')!;

export const sceneById = (id: string | null | undefined): Scene | undefined => SCENES.find(scene => scene.id === id);
/** The scene a thread always shows; no thread (the new-task page, the welcome) shows the sky. */
export const sceneFor = (threadId: string | null | undefined): Scene => threadId ? SCENES[sceneIndex(threadId, SCENES.length)] : SKY;
export type { Scene } from './types';
