// Harness and model lists for a host, fetched once per screen when missing.
import { useEffect, useState } from 'react';
import { connect } from '../connect/client.ts';
import { useModels, useProviders } from '../store/index.ts';
import type { Option } from './Choice.tsx';
import { modelLabel as readableModel } from './model-label.ts';

/** A model's display name: the host's when listed, otherwise its id with a capital ("opus" → "Opus"). */
export function modelLabel(id: string, models?: readonly { id: string; name: string }[] | null): string {
  return models?.find(model => model.id === id)?.name ?? readableModel(id);
}

export function useModelOptions(deviceId: string, provider: string) {
  const providers = useProviders(deviceId);
  const models = useModels(deviceId, provider);
  const key = `${deviceId}/${provider}`;
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (deviceId && !providers) connect.listProviders(deviceId).catch((error: Error) => setFailure({ key, message: error.message }));
  }, [deviceId, providers, key, attempt]);
  useEffect(() => {
    if (deviceId && provider && !models) connect.listModels(deviceId, provider).catch((error: Error) => setFailure({ key, message: error.message }));
  }, [deviceId, provider, models, key, attempt]);
  const retry = () => { setFailure(null); setAttempt(a => a + 1); };
  const harnesses: Option[] = (providers ?? []).filter(p => p.installed).map(p => ({ value: p.id, label: p.name }));
  const modelOptions: Option[] = (models ?? []).map(m => ({ value: m.id, label: m.name }));
  const efforts = (id: string): Option[] => (models?.find(m => m.id === id)?.reasoningEfforts ?? []).map(e => ({ value: e.id, label: e.name }));
  const defaultEffort = (id: string) => models?.find(m => m.id === id)?.defaultReasoningEffort ?? null;
  return { harnesses, models: modelOptions, efforts, defaultEffort, loaded: !!providers, error: failure?.key === key ? failure.message : null, retry };
}
