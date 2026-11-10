import { escape, icon } from './dom';
import type { VoiceConfiguration, VoiceProfile } from './voice-types';

/** Pending native mutations, keyed `select:<id|off>` and `delete:<id>`. */
export type PendingActions = ReadonlySet<string>;

export function selectedProfile(configuration: VoiceConfiguration | undefined): VoiceProfile | undefined {
  return configuration?.profiles.find(profile => profile.id === configuration.selectedProfileId);
}

export function readinessText(configuration: VoiceConfiguration | undefined, loading: boolean, localInUse = false): string {
  if (!configuration) return loading ? 'Loading voice input…' : 'Voice input unavailable';
  const selected = selectedProfile(configuration);
  if (!selected && localInUse) return 'Transcribing on this device. Saved services are kept.';
  if (!selected) return 'Voice input is off';
  if (selected.provider !== 'custom' && !selected.hasKey) return `${selected.name}: API key needed`;
  return `Ready to dictate: ${selected.name}`;
}

function credentialText(profile: VoiceProfile): string {
  if (profile.hasKey) return 'Key saved';
  return profile.provider === 'custom' ? 'No key · server must be running' : 'API key needed';
}

function confirmControls(profile: VoiceProfile, deleting: boolean): string {
  const id = escape(profile.id), name = escape(profile.name), disabled = deleting ? 'disabled' : '';
  return `<button type="button" class="secondary-button" data-voice-keep="${id}" aria-label="Cancel deleting ${name}" ${disabled}>Cancel</button>`
    + `<button type="button" class="secondary-button" data-voice-confirm-delete="${id}" aria-label="Confirm deleting ${name}" ${disabled}>`
    + `${deleting ? 'Deleting…' : 'Delete profile'}</button>`;
}

function rowControls(profile: VoiceProfile, active: boolean, selecting: boolean): string {
  const id = escape(profile.id), name = escape(profile.name);
  const useLabel = selecting ? 'Switching…' : active ? 'In use' : 'Use';
  return `<button type="button" class="secondary-button" data-voice-edit="${id}" aria-label="Edit ${name}">Edit</button>`
    + `<button type="button" class="secondary-button" data-voice-use="${id}" aria-label="Use ${name}" ${active || selecting ? 'disabled' : ''}>${useLabel}</button>`
    + `<button type="button" class="ds-btn ds-btn-icon" data-voice-delete="${id}" aria-label="Delete ${name}" data-tip="Delete">${icon('trash')}</button>`;
}

function profileRow(profile: VoiceProfile, active: boolean, confirming: boolean, pending: PendingActions): string {
  const controls = confirming
    ? confirmControls(profile, pending.has(`delete:${profile.id}`))
    : rowControls(profile, active, pending.has(`select:${profile.id}`));
  const warning = confirming ? '<small class="voice-delete-warning" role="status">Delete this profile and its saved key?</small>' : '';
  return `<div class="setting-row voice-profile" data-id="${escape(profile.id)}"><div><strong>${escape(profile.name)}</strong>`
    + `<small class="voice-profile-model">${escape(profile.model)}</small><small>${active ? 'In use · ' : ''}${credentialText(profile)}</small>`
    + `<small class="voice-profile-endpoint">Destination: ${escape(profile.endpoint)}</small>${warning}</div>`
    + `<div class="settings-row-actions">${controls}</div></div>`;
}

/** The saved-profile list, or its empty state. */
export function profilesHtml(configuration: VoiceConfiguration | undefined, confirmingId: string | undefined, pending: PendingActions): string {
  const rows = configuration?.profiles.map(profile => profileRow(profile, profile.id === configuration.selectedProfileId, confirmingId === profile.id, pending));
  return rows?.join('') || '<p class="voice-empty">No speech profiles yet. Add one below to enable dictation.</p>';
}
