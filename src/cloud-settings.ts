/* Settings → Agents → Cloud sandboxes: connect Daytona, Cloudflare, AWS and the keyed sandbox
 * providers so agents can create and use cloud machines (and run on them as cloud agents), and
 * Vercel, Railway, Netlify and Google Cloud for deploys. Keys go straight to the OS keychain natively;
 * this view never reads them back. */
import './cloud-settings.css';
import { escape, icon, isImeKey } from './dom';
import { errorText } from './error-text';
import { infoMark } from './tooltip';
import { t } from './i18n.ts';

export type CloudConnection = { provider: 'daytona' | 'cloudflare' | 'aws' | 'vercel' | 'railway' | 'netlify' | 'gcloud' | 'docker' | 'colab' | KeyedProvider; connected: boolean; detail: string | null; sandboxes?: boolean; inheritEnvironment?: boolean };
/** `colab-sign-in` events while Google Colab signs in from Settings. */
export type ColabSignInUpdate = { id: number; state: 'installing' | 'waiting' | 'exchanging' | 'done' | 'failed' | 'cancelled'; url?: string; message?: string; detail?: string };
/** `cloud_colab_sign_in_status`: the sign-in still running in the background, if any. */
export type ColabSignInStatus = { id: number; state: 'installing' | 'waiting' | 'exchanging'; url?: string; message?: string } | null;
/** `cloud_colab_usage`: compute units, fetched from Google apart from the instant local config. */
export type ColabUsage = { ccuBalance: number | null; ccuRate: number | null };
export type ColabAccelerator = 'NONE' | 'T4' | 'L4' | 'G4' | 'A100' | 'H100' | 'V5E1' | 'V6E1';
/** `cloud_colab_config`: the saved Colab defaults and which local tools it can use. */
export type ColabConfig = {
  connected: boolean; email: string | null; authMode: 'oauth2' | 'adc'; accelerator: ColabAccelerator; highMem: boolean;
  nativeTools: boolean; colabMcp: boolean; colabCliInstalled: boolean; uvxInstalled: boolean; gcloudInstalled: boolean;
  ccuBalance?: number | null; ccuRate?: number | null;
};
type CloudEvents = { 'cloud-setup': { provider: string; label: string }; 'colab-sign-in': ColabSignInUpdate };
export type CloudSettingsHost = {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<K extends keyof CloudEvents>(name: K, callback: (event: CloudEvents[K]) => void): Promise<() => void>;
};

/** `sparse` options are sent only when filled (the cloud agent fields added to deploy providers). */
type Field = { name: string; label: string; placeholder: string; secret?: boolean; optional?: boolean; sparse?: boolean };
/* Sandbox providers that connect with one API key (docs/cloud-agents.md → Provider settings). */
const KEYED = {
      toggle.textContent = connection?.connected ? t('Disconnect') : form.hidden ? t('Connect') : t('Close');
      toggle.disabled = Boolean(busy);
      toggle.setAttribute('aria-label', `${toggle.textContent} ${PROVIDERS[id].name}`);
