// ─── Storage keys (internal — never shown to users) ──────────────────────────
const VOICES_STORAGE = "ss_custom_voices";

// Keys used to live in localStorage before the account gateway existed. They must
// never sit on the machine again — all AI keys are admin-controlled now.
const LEGACY_KEY_STORAGE = ["ss_api_key", "ss_elevenlabs_key", "ss_license_key", "ss_demo_key"];

// Old builds kept a local, invented session history. Usage now comes from the
// gateway ledger, so nothing should still be reading it off the disk.
const LEGACY_LOCAL_HISTORY = ["ss_session_history"];

export function purgeLegacyKeys(): void {
  for (const k of [...LEGACY_KEY_STORAGE, ...LEGACY_LOCAL_HISTORY]) localStorage.removeItem(k);
}

// ─── Custom cloned voices (persisted across sessions) ────────────────────────
export interface SavedVoice {
  id:        string;
  name:      string;
  createdAt: number;
}

export function getSavedVoices(): SavedVoice[] {
  try { return JSON.parse(localStorage.getItem(VOICES_STORAGE) ?? "[]"); }
  catch { return []; }
}

export function addSavedVoice(voice: SavedVoice): void {
  const voices = getSavedVoices();
  voices.unshift(voice);
  localStorage.setItem(VOICES_STORAGE, JSON.stringify(voices.slice(0, 20)));
}

export function removeSavedVoice(id: string): void {
  const voices = getSavedVoices().filter(v => v.id !== id);
  localStorage.setItem(VOICES_STORAGE, JSON.stringify(voices));
}

export function clearCredentials(): void {
  localStorage.removeItem(VOICES_STORAGE);
}
