// The transcriber is asked for his words. Sometimes it answers with a description of the room
// instead - a bracketed note about the noise, a label for a speaker, an apology that nothing could
// be heard - and until 1.8.48 that answer went straight to his cloned voice and came out of the
// call as if HE had said it. A customer whose line starts reading the furniture is not going to
// trust anything after it.
//
// The rule is a subtractive one, and it never invents or reorders what he said: descriptions are
// taken out, and if the turn then holds nothing a person could have spoken, the turn is dropped and
// the voice stays quiet. Dropping is the same path an empty transcription already took, so nothing
// new is timed, billed or announced.

// [noise], (inaudible), {silence}, <unk> - the four pairs an engine wraps a non-word in. Bounded so
// an unpaired bracket in the middle of a real sentence cannot eat the rest of it.
const DESCRIPTION = /[[({<][^\])}>]{0,80}[\])}>]/g;

// What the audio IS, as opposed to what a person says. A turn made of nothing but these names the
// recording, not a speaker - so it is dropped.
const ABOUT_AUDIO = new Set([
  "background", "noise", "ambient", "room", "static", "hum", "music", "television", "tv",
  "sound", "sounds", "silence", "silent", "inaudible", "unintelligible", "speech", "audio",
  "applause", "laughter", "laughing", "cough", "coughing", "sigh", "sighing", "breathing",
  "singing", "blank", "unknown", "unk",
]);

// Words that only hang the description together. A bare "No" is a thing a man really says, so these
// alone never drop a turn - it takes one of the words above with them.
const CONNECTIVE = new Set([
  "no", "not", "available", "the", "a", "an", "there", "here", "this", "that", "is", "was",
  "are", "were", "of", "for", "and", "in", "it",
]);

// "Speaker 1:", "[00:12] Person 2 -" and whatever else an engine puts in front of the words.
const SPEAKER_LABEL = /^[^a-z0-9]*(?:speaker|person|man|woman|voice|user|host|child|boy|girl)\s*\d*\s*[:\-–—]\s*/i;

export function speakableWords(raw: string): string {
  if (!raw) return "";
  let t = raw.replace(DESCRIPTION, " ").replace(/\s+/g, " ").trim();
  // A label can survive its own brackets being removed, and it is never part of what he said.
  while (SPEAKER_LABEL.test(t)) t = t.replace(SPEAKER_LABEL, "");
  const words = t.toLowerCase().replace(/[^a-z'\s]/g, " ").split(/\s+/).filter(Boolean);
  // Every remaining word names the recording, and at least one of them actually does: the turn held
  // no speech, and there is nothing for the cloned voice to say.
  const about = words.filter(w => ABOUT_AUDIO.has(w)).length;
  if (about > 0 && words.every(w => ABOUT_AUDIO.has(w) || CONNECTIVE.has(w))) return "";
  return t;
}
