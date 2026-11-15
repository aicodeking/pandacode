import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { markupCache } from '../src/transcript-rows.ts';
import * as i18n from '../src/i18n.ts';
import zhHans from '../src/locales/zh-Hans.ts';
import ts from 'typescript';

/* The open thread serves each saved turn's markup from a cache (savedTurnHtml in src/main.ts) that holds while the
 * turn's `parts` and `markupEnv` are unchanged. A new input to turnHtml that is in neither would serve stale rows
 * without any test noticing, so the code of turnHtml and the functions it draws a turn with (in main.ts and the modules it calls) is pinned here. When this
 * fails: check every value the changed code reads; anything that is not the turn's own messages must be in savedTurnHtml's
 * `parts` or in `markupEnv`. Then record the new hash below. */
const PINNED = {
  'src/main.ts': ['turnHtml', 'turnCardHtml', 'turnLeadHtml', 'notesHtml', 'workerSlot', 'turnWorkerStart', 'cardless', 'cardErrorsHtml', 'errorsOpenKey', 'savedErrorsHtml', 'errorRowHtml', 'dismissAllHtml', 'dismissedNoteHtml', 'liveErrorOpen', 'cardFootHtml', 'earlierChangeSets', 'savedActivityHtml', 'savedTurnActivity', 'markupEnv', 'savedTurnHtml',
    'messageHtml', 'activityHtml', 'accountSwitchHtml', 'userContent', 'foldedLabelHtml', 'changesRow', 'changesFoot', 'steerStateHtml'],
  'src/message-actions.ts': ['messageActionsHtml'],
  'src/schedules-thread.ts': ['scheduledMark', 'workflowStep'],
  'src/turn-changes.ts': ['renderTurnChanges', 'turnChangesFoot', 'fileTree'],
  'src/dom.ts': ['fileIcon'],
  'src/turn-activity.ts': ['turnLabel'],
  'src/provider-logos.ts': ['providerLogo'],
  'src/provider-handoff.ts': ['historicalProvider'],
  'src/tool-activity.ts': ['renderToolGroup', 'renderToolActivity'],
  'src/turn-card.ts': ['replyHtml', 'timeHtml'],
  'src/transcript-host.ts': ['lastHandoff', 'turnMessages', 'markupShared'],
};
// Translated message actions and changes cards read the active UI locale through markupShared.
const RECORDED = '185ec93aac4703f7';
