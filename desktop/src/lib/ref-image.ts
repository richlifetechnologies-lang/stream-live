// The customer's photo is the largest thing this app puts on the wire, and the video line has a
// hard limit on how much it will read in one message. A photo straight off a phone is several
// megabytes; base64 makes it a third bigger again; and the line answers by closing the socket
// without ever taking the call. This app used to report that as "no connection came up", which
// blamed his network for a file that was simply too big.
//
// Two rules hold here:
//
//  1. A photo that already fits is sent EXACTLY as he picked it - the same bytes, the same pixels,
//     no re-encode. Nothing that works today is touched.
//  2. Only one that cannot fit is redrawn, and it is redrawn to a long edge still above the
//     1280x720 the call is delivered at, so the face he recognises is the same face.

/** The largest photo this app will put on the wire, counted in file bytes. */
export const PHOTO_MAX_BYTES = 500_000;

/** The long edge a too-large photo is redrawn to. The picture itself is delivered at 1280x720. */
export const PHOTO_LONG_EDGE = 1024;
const PHOTO_QUALITY = 0.82;

/** A second, smaller pass for a photo that redraws huge (a painting, a screenshot with text). */
const PHOTO_LONG_EDGE_2 = 800;
const PHOTO_QUALITY_2 = 0.70;

export type PreparedPhoto =
  | { ok: true; b64: string; preview: string; bytes: number; fromBytes: number; resized: boolean }
  | { ok: false; why: "unreadable" | "too_big"; bytes: number };

/** Whether this file can go on the wire as it stands. Pure, so the offline check can drive it. */
export function photoFits(bytes: number): boolean { return bytes <= PHOTO_MAX_BYTES; }

/** Bytes of file behind a base64 body. */
function b64Bytes(b64: string): number { return Math.floor(b64.length * 3 / 4); }

type Picture = CanvasImageSource & { w: number; h: number };

async function loadPicture(file: File): Promise<Picture | null> {
  const url = URL.createObjectURL(file);
  try {
    if (typeof createImageBitmap === "function") {
      try {
        const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
        if (bmp.width && bmp.height) return Object.assign(bmp, { w: bmp.width, h: bmp.height });
      } catch { /** the img route still answers for a file this build can display */ }
    }
    const img = await new Promise<HTMLImageElement | null>(res => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => res(null);
      i.src = url;
    });
    if (!img || !img.naturalWidth || !img.naturalHeight) return null;
    return Object.assign(img, { w: img.naturalWidth, h: img.naturalHeight });
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Redraw at a capped long edge and hand back a JPEG body. Null on any canvas or decode failure. */
function encodeJpeg(pic: Picture, longEdge: number, quality: number):
  { b64: string; preview: string; bytes: number; width: number; height: number } | null {
  const scale = Math.min(1, longEdge / Math.max(pic.w, pic.h));
  const w = Math.max(1, Math.round(pic.w * scale));
  const h = Math.max(1, Math.round(pic.h * scale));
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(pic, 0, 0, w, h);
  const preview = cv.toDataURL("image/jpeg", quality);
  const b64 = preview.split(",")[1] ?? "";
  if (!b64) return null;
  return { b64, preview, bytes: b64Bytes(b64), width: w, height: h };
}

/**
 * Get a picked photo into a state the video line will take.
 *
 * Every failure is returned, never thrown and never silent: the caller has to be able to tell the
 * customer, in front of him, instead of dialling a call the line is going to refuse.
 */
export async function prepareRefPhoto(file: File): Promise<PreparedPhoto> {
  const original = await new Promise<string>(res => {
    const r = new FileReader();
    r.onload = () => res(String(r.result ?? ""));
    r.onerror = () => res("");
    r.readAsDataURL(file);
  });
  const raw = original.split(",")[1] ?? "";
  if (!raw) return { ok: false, why: "unreadable", bytes: file.size };

  if (photoFits(file.size)) {
    // His file, untouched: the bytes on the wire are the bytes on his disk.
    return { ok: true, b64: raw, preview: original, bytes: file.size, fromBytes: file.size, resized: false };
  }

  const pic = await loadPicture(file);
  if (!pic) return { ok: false, why: "unreadable", bytes: file.size };

  for (const [edge, q] of [[PHOTO_LONG_EDGE, PHOTO_QUALITY], [PHOTO_LONG_EDGE_2, PHOTO_QUALITY_2]] as const) {
    const out = encodeJpeg(pic, edge, q);
    if (out && photoFits(out.bytes)) return { ...out, fromBytes: file.size, resized: true, ok: true };
  }
  return { ok: false, why: "too_big", bytes: file.size };
}
