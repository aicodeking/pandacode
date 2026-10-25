import './browser.css';
import { call, preview, subscribe, webMode } from './bridge';
import { escape, icon } from './dom';
import { t } from './i18n.ts';
import { mountJevLive, type JevLiveView } from './jev-live';
import { pageZoom } from './ui-size';
import type { BrowserAttachment, BrowserBounds, BrowserElement, BrowserScreenshot, BrowserStatus, LocalServer } from './types';

export interface BrowserPanel { close(): Promise<void>; refresh(): void; navigate(url: string): Promise<BrowserStatus>; watchJev(runId: string): Promise<void>; }
type Options = { task(): string | undefined; session(): string | undefined; navigated?(url: string): void; attach(taskId: string, attachment: BrowserAttachment): void; close(): void; test?(url?: string, anchor?: HTMLElement): void; };
// Tauri 2 packs a Linux child webview into the window's GtkBox below the app
// instead of placing it at the given bounds (set_bounds is a no-op there), so
// the guest lands in a bottom pane and window resizes fight over the split.
// ponytail: system browser on Linux; embed again once the guest sits in a GtkOverlay.
export const embedsGuest = (platform: string, sample: boolean): boolean => sample || !/Linux/i.test(platform);
    async watchJev(runId) { if (disposed) throw new Error(t('Browser is closed.')); await live?.watch(runId); },
    refresh() { live?.refresh(); if (pickTask && pickTask !== options.task()) { pickTask = undefined; void enqueue(() => call('browser_pick', { enabled: false })).catch(fail); } updateControls(); scheduleBounds(); },
