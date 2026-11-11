// The task stages' names, one table for every screen (Board, Task info): the desktop board's own
// (src/task-board.ts `stageNames`), so a phone and a computer call a stage the same thing.
import type { Stage } from './thread-model.ts';

export const STAGE_NAMES: Readonly<Record<Stage, string>> = { pending: 'Pending', in_progress: 'In progress', review: 'Review', completed: 'Settled' };

/** A stage's name; an unknown one (a newer host) as it came. */
export const stageName = (stage: string): string => (STAGE_NAMES as Record<string, string>)[stage] ?? stage;
