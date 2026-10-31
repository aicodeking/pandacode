// Loads one attachment or workspace image for display (connect.attachment → a file:// URI).
import { useEffect, useState } from 'react';
import { connect } from '../connect/client.ts';
import { cachedAttachment, type Source } from '../connect/attachments.ts';
import { attachmentKey, workspaceId, type Variant } from '../store/attachments.ts';

/** One image the UI can show: a message attachment (`id`) or a workspace image (`path`). */
export interface ViewerImage { deviceId: string; sessionId: string; id?: string; path?: string; name: string; width?: number; height?: number }

type Loaded = { uri?: string; error?: string };

/** The attachment's file:// URI once it is on the phone; `enabled: false` waits (viewer pages off screen). */
export function useAttachment(image: ViewerImage, variant: Variant, enabled = true): Loaded {
  const { deviceId, sessionId, id, path } = image;
  const source: Source = path !== undefined ? { path } : { id: id ?? '' };
  const key = attachmentKey(deviceId, sessionId, path !== undefined ? workspaceId(path) : id ?? '', variant);
  const [state, setState] = useState<Loaded & { key?: string }>(() => ({ key, uri: cachedAttachment(deviceId, sessionId, source, variant) }));
  const current = state.key === key ? state : {};
  const done = !!current.uri || !!current.error;
  useEffect(() => {
    if (!enabled || done) return;
    let live = true;
    const from: Source = path !== undefined ? { path } : { id: id ?? '' };
    connect.attachment(deviceId, sessionId, from, variant).then(
      uri => { if (live) setState({ key, uri }); },
      (error: Error) => { if (live) setState({ key, error: error?.message || 'Could not load this image.' }); },
    );
    return () => { live = false; };
  }, [key, enabled, done, deviceId, sessionId, id, path, variant]);
  return current;
}

