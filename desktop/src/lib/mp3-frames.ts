// Where an MP3 answer may be cut while it is still arriving.
//
// The voice service answers in MPEG Layer III frames: 418 bytes and about 26 ms of audio apiece at
// the 128 kbps its replies actually come back at. An answer can be put on air before its last byte
// lands only if the bytes handed over stop on a frame edge - a cut inside a frame makes the decoder
// refuse the whole file rather than just its tail, which is the difference between a cloned voice
// that starts a second sooner and a call with no voice at all.

const BITRATE_MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATE_MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATE = [[11025, 12000, 8000, 0], [22050, 24000, 16000, 0], [0, 0, 0, 0], [44100, 48000, 32000, 0]];

/** The size of the Layer III frame starting here, or 0 when there is no frame header here. */
function frameBytes(b: Uint8Array, i: number): number {
  if (i + 4 > b.length) return 0;
  if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return 0;
  const version = (b[i + 1] >> 3) & 3;   // 0 = MPEG 2.5, 1 = reserved, 2 = MPEG 2, 3 = MPEG 1
  const layer = (b[i + 1] >> 1) & 3;     // 1 = Layer III
  if (version === 1 || layer !== 1) return 0;
  const br = (b[i + 2] >> 4) & 15;
  const sr = (b[i + 2] >> 2) & 3;
  if (br === 0 || br === 15 || sr === 3) return 0;
  const kbps = version === 3 ? BITRATE_MPEG1_L3[br] : BITRATE_MPEG2_L3[br];
  const rate = SAMPLE_RATE[version][sr];
  if (!kbps || !rate) return 0;
  return Math.floor(144000 * kbps / rate) + ((b[i + 2] >> 1) & 1);
}

// A reply opens with an ID3v2 tag (the service's own encoder marks its work in it), and its size is
// written in the seven-bit-packing the format calls synchsafe. Counting it as audio would walk into
// the middle of the tag looking for a frame edge that is not there.
function afterId3(b: Uint8Array, i: number): number {
  while (i + 10 <= b.length && b[i] === 0x49 && b[i + 1] === 0x44 && b[i + 2] === 0x33) {
    const size = ((b[i + 6] & 0x7f) << 21) | ((b[i + 7] & 0x7f) << 14) | ((b[i + 8] & 0x7f) << 7) | (b[i + 9] & 0x7f);
    if (size <= 0) break;
    i += 10 + size;
  }
  return i;
}

/**
 * How many leading bytes of an answer are whole frames, so only they are ever handed to a decoder.
 * 0 means nothing complete has arrived yet; -1 means this is not an MP3 this file can walk, and the
 * caller must fall back to waiting for the whole answer exactly as it did before.
 */
export function mp3WholeFrameBytes(b: Uint8Array): number {
  const start = afterId3(b, 0);
  if (start >= b.length) return 0;
  if (frameBytes(b, start) === 0) return start === 0 && b.length < 4 ? 0 : -1;
  let i = start, last = start;
  while (i < b.length) {
    const n = frameBytes(b, i);
    if (!n || i + n > b.length) break;
    i += n;
    last = i;
  }
  return last;
}
