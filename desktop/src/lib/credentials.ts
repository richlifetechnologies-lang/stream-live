// ─── Storage keys (internal — never shown to users) ──────────────────────────
const ENGINE_KEY_STORAGE = "ss_api_key";
const VOICE_KEY_STORAGE  = "ss_elevenlabs_key";
const VOICES_STORAGE     = "ss_custom_voices";

// ─── Stream Studio Engine key (video AI) ─────────────────────────────────────
export function getApiKey(): string | null {
  return localStorage.getItem(ENGINE_KEY_STORAGE);
}
export function setApiKey(key: string): void {
  localStorage.setItem(ENGINE_KEY_STORAGE, key.trim());
}
export function hasCredentials(): boolean {
  const key = getApiKey();
  return !!key && key.length > 8;
}

// ─── Voice Studio key (voice engine) ─────────────────────────────────────────
export function getVoiceKey(): string | null {
  return localStorage.getItem(VOICE_KEY_STORAGE);
}
export function setVoiceKey(key: string): void {
  localStorage.setItem(VOICE_KEY_STORAGE, key.trim());
}
export function hasVoiceKey(): boolean {
  const key = getVoiceKey();
  return !!key && key.length > 8;
}
// Keep old names as aliases so any remaining imports don't break
export const getElevenLabsKey = getVoiceKey;
export const setElevenLabsKey = setVoiceKey;
export const hasElevenLabsKey = hasVoiceKey;

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

// ─── Clear everything ─────────────────────────────────────────────────────────
export function clearCredentials(): void {
  localStorage.removeItem(ENGINE_KEY_STORAGE);
  localStorage.removeItem(VOICE_KEY_STORAGE);
  localStorage.removeItem(VOICES_STORAGE);
}
