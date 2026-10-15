// The single source of truth for what "Stream Live Camera" actually sends.
//
// The device frame is always 1280x720 because that is the shape calling apps
// negotiate out of the DirectShow filter's format list — we cannot advertise a
// 9:16 entry from a bundled vendor filter. Portrait therefore paints a centred
// 9:16 "phone" rectangle INSIDE that frame and fills it edge to edge, the way a
// handset fills its screen, with black at the sides.
//
// Filling a 9:16 frame from a 16:9 source cuts the left and right of the wide
// scene. That is geometry, not a setting: the subject sits in the middle of the
// AI frame, so what is dropped is background.
//
// The side space used to carry a blurred, dimmed copy of the scene. Anything
// close to the lens — a hand reaching for the camera — was stretched into a
// smear across the whole frame, so it is left black.
//
// Both the virtual-camera pump and the dev preview page call this, so what you
// see on screen is the same arithmetic the caller receives. The source is a
// video during a call and a canvas in the preview, hence the union.
export type FrameSource = HTMLVideoElement | HTMLCanvasElement;

function intrinsic(s: FrameSource): { w: number; h: number; ready: boolean } {
  if (s instanceof HTMLCanvasElement) return { w: s.width, h: s.height, ready: s.width > 0 };
  return { w: s.videoWidth, h: s.videoHeight, ready: s.videoWidth > 0 && s.readyState >= 2 };
}

export function drawOutputFrame(
  ctx: CanvasRenderingContext2D,
  v: FrameSource | null,
  W: number,
  H: number,
  portrait: boolean,
): void {
  const src = v ? intrinsic(v) : { w: 0, h: 0, ready: false };
  if (!v || !src.ready) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    return;
  }

  const vr = src.w / src.h;

  if (!portrait) {
    // Landscape: fill the frame, keeping the source aspect. For a 16:9 source
    // this is an exact 1:1 fit — the path that already works in the field.
    let dw = W, dh = H, dx = 0, dy = 0;
    if (vr > W / H) { dh = H; dw = H * vr; dx = (W - dw) / 2; }
    else            { dw = W; dh = W / vr; dy = (H - dh) / 2; }
    ctx.drawImage(v, dx, dy, dw, dh);
    return;
  }

  const pw = Math.round(H * 9 / 16);      // 9:16 rectangle, full height
  const px = Math.round((W - pw) / 2);    // centred inside the wide device frame

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);

  // Cover-fit inside the rectangle, clipped: the picture fills it top to bottom
  // and side to side, and the overflow past the left/right edges is what is cut.
  ctx.save();
  ctx.beginPath();
  ctx.rect(px, 0, pw, H);
  ctx.clip();
  let dw: number, dh: number;
  if (vr > pw / H) { dh = H; dw = H * vr; }
  else             { dw = pw; dh = pw / vr; }
  ctx.drawImage(v, px + (pw - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.restore();
}
