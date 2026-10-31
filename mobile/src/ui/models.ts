// Harness and model lists for a host, fetched once per screen when missing.
import { useEffect } from 'react';
import { connect } from '../connect/client.ts';
import { useModels, useProviders } from '../store/index.ts';
import type { Option } from './Choice.tsx';

export function useModelOptions(deviceId: string, provider: string) {
  const providers = useProviders(deviceId);
  const models = useModels(deviceId, provider);
  useEffect(() => { if (deviceId && !providers) connect.listProviders(deviceId).catch(() => undefined); }, [deviceId, providers]);
  useEffect(() => { if (deviceId && provider && !models) connect.listModels(deviceId, provider).catch(() => undefined); }, [deviceId, provider, models]);
  const harnesses: Option[] = (providers ?? []).filter(p => p.installed).map(p => ({ value: p.id, label: p.name }));
  const modelOptions: Option[] = (models ?? []).map(m => ({ value: m.id, label: m.name }));
  const efforts = (id: string): Option[] => (models?.find(m => m.id === id)?.reasoningEfforts ?? []).map(e => ({ value: e.id, label: e.name }));
  const defaultEffort = (id: string) => models?.find(m => m.id === id)?.defaultReasoningEffort ?? null;
  return { harnesses, models: modelOptions, efforts, defaultEffort, loaded: !!providers };
}
