// The single source of truth for what "Stream Live Camera" actually sends.
//
// The device frame is always 1280x720 because that is the shape calling apps
// negotiate out of the DirectShow filter's format list — we cannot advertise a
// 9:16 entry from a bundled vendor filter. Portrait therefore paints a centred
// 9:16 "phone" rectangle INSIDE that frame and fills it edge to edge, the way a
// handset fills its screen, with a blurred, dimmed copy of the scene behind it.
//
// Filling a 9:16 frame from a 16:9 source cuts the left and right of the wide
// scene. That is geometry, not a setting: the subject sits in the middle of the
// AI frame, so what is dropped is background.
//
// Both the virtual-camera pump and the dev preview page call this, so what you
// see on screen is the same arithmetic the caller receives. The source is a
// video during a call and a canvas in the preview, hence the union.
export type FrameSource = HTMLVideoElement | HTMLCanvasElement;

function intrinsic(s: FrameSource): { w: number; h: number; ready: boolean } {
  if (s instanceof HTMLCanvasElement) return { w: s.width, h: s.height, ready: s.width > 0 };
  return { w: s.videoWidth, h: s.videoHeight, ready: s.videoWidth > 0 && s.readyState >= 2 };
}

// The backdrop is blurred at 1/8 scale, not at frame scale. Blurring a 1280x720
// pass measured 31ms per frame on the build machine against a 33ms budget that
// also has to read the frame back and hand it to the driver, which would have
// halved the call's frame rate. A 3px blur on a 160x90 buffer is the same 24px
// softness once it is stretched, for a fraction of the cost.
const BACKDROP_W = 160;
const OVER = 1.12;   // over-cover so the blur's edge falloff lands off-frame
let backdropCanvas: HTMLCanvasElement | null = null;

function drawBackdrop(
  ctx: CanvasRenderingContext2D,
  v: FrameSource,
  W: number,
  H: number,
  vr: number,
): void {
  if (!backdropCanvas) {
    backdropCanvas = document.createElement("canvas");
    backdropCanvas.width = BACKDROP_W;
    backdropCanvas.height = Math.round(BACKDROP_W * 9 / 16);
  }
  const bw = backdropCanvas.width, bh = backdropCanvas.height;
  const bx = backdropCanvas.getContext("2d");
  if (!bx) return;

  // Cover-fit the source into the small buffer, blurring as it is drawn: one
  // pass over 160x90 pixels instead of a full-frame filter pass.
  let dw: number, dh: number;
  if (vr > bw / bh) { dh = bh; dw = bh * vr; }
  else              { dw = bw; dh = bw / vr; }
  dw *= OVER; dh *= OVER;
  bx.setTransform(1, 0, 0, 1, 0, 0);
  bx.filter = "blur(3px) brightness(0.55)";
  bx.drawImage(v, (bw - dw) / 2, (bh - dh) / 2, dw, dh);
  bx.filter = "none";

  ctx.drawImage(backdropCanvas, 0, 0, W, H);
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
  drawBackdrop(ctx, v, W, H, vr);         // the side space, blurred and dimmed

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
