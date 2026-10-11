/*
  Stream Studio - Virtual Camera Frame Feeder
  -------------------------------------------
  Feeds RGBA8 frames into the "Stream Studio Camera" DirectShow filter
  (UnityCapture) via its shared-memory protocol, so calling apps (Zoom, Teams,
  Chrome, Discord, WhatsApp...) see the AI video output as a real webcam.

  Protocol (matches UnityCapture shared.inl, CapNum 0):
    named objects  : UnityCapture_Mutx / _Want / _Sent / _Data
    shared header  : u32 maxSize, i32 width, height, stride(pixels),
                     format(0=UINT8), resizemode(1=LINEAR), mirrormode(1=HORIZ),
                     timeout(ms)   -> 32 bytes, then RGBA8 pixels
    sender (us)    : CreateEvent(Want); OpenMutex/OpenEvent(Sent)/OpenFileMapping(Data)
                     lock mutex -> write header+pixels -> unlock -> SetEvent(Sent)

  The receiver (the filter, running inside the calling app) creates the mutex,
  Sent event and file mapping when the app opens the camera, so we poll until
  those exist ("ready"). Everything is wrapped in try/catch: if koffi or the
  native layer is unavailable the app runs exactly as before, with the virtual
  camera simply disabled.
*/
import { IpcMain } from "electron";

const NAMES = {
  MUTEX: "UnityCapture_Mutx",
  WANT:  "UnityCapture_Want",
  SENT:  "UnityCapture_Sent",
  DATA:  "UnityCapture_Data",
};

const SYNCHRONIZE          = 0x00100000;
const EVENT_MODIFY_STATE   = 0x0002;
const FILE_MAP_WRITE       = 0x0002;
const INFINITE_UNUSED      = 50; // ms - never block the main thread for long
const WAIT_OBJECT_0        = 0;

const HEADER_SIZE          = 32;
const FORMAT_UINT8         = 0;
const RESIZEMODE_LINEAR    = 1;
const MIRRORMODE_HORIZONTAL= 1;
const FRAME_TIMEOUT_MS     = 1000;

type Koffi = any;

interface FeederState {
  supported: boolean;
  active: boolean;
  ready: boolean;
  error: string | null;
  k32: Koffi | null;
  fn: Record<string, any>;
  hWant: any;
  hMutex: any;
  hSent: any;
  hFile: any;
  view: any;
  combined: Buffer | null;
  maxSize: number;
}

const S: FeederState = {
  supported: false, active: false, ready: false, error: null,
  k32: null, fn: {},
  hWant: null, hMutex: null, hSent: null, hFile: null, view: null,
  combined: null, maxSize: 0,
};

function loadKoffi(): boolean {
  if (S.supported) return true;
  try {
    // Lazy require so a packaging/native failure never breaks app startup.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require("koffi");
    const k32 = koffi.load("kernel32.dll");
    S.fn = {
      CreateEventA:      k32.func("void *CreateEventA(void *, int, int, const char *)"),
      OpenEventA:        k32.func("void *OpenEventA(uint32, int, const char *)"),
      OpenMutexA:        k32.func("void *OpenMutexA(uint32, int, const char *)"),
      OpenFileMappingA:  k32.func("void *OpenFileMappingA(uint32, int, const char *)"),
      MapViewOfFile:     k32.func("void *MapViewOfFile(void *, uint32, uint32, uint32, size_t)"),
      UnmapViewOfFile:   k32.func("int UnmapViewOfFile(void *)"),
      WaitForSingleObject: k32.func("uint32 WaitForSingleObject(void *, uint32)"),
      ReleaseMutex:      k32.func("int ReleaseMutex(void *)"),
      SetEvent:          k32.func("int SetEvent(void *)"),
      CloseHandle:       k32.func("int CloseHandle(void *)"),
      RtlMoveMemory:     k32.func("void RtlMoveMemory(void *, void *, size_t)"),
    };
    S.k32 = koffi;
    S.supported = true;
    S.error = null;
    return true;
  } catch (e: any) {
    S.supported = false;
    S.error = `koffi unavailable: ${e?.message ?? String(e)}`;
    return false;
  }
}

function closeHandles() {
  const f = S.fn;
  try { if (S.view)   f.UnmapViewOfFile(S.view); } catch {}
  try { if (S.hFile)  f.CloseHandle(S.hFile); }  catch {}
  try { if (S.hSent)  f.CloseHandle(S.hSent); }  catch {}
  try { if (S.hMutex) f.CloseHandle(S.hMutex); } catch {}
  try { if (S.hWant)  f.CloseHandle(S.hWant); }  catch {}
  S.view = S.hFile = S.hSent = S.hMutex = S.hWant = null;
  S.ready = false;
}

// Create the Want event early: the filter OPENS it when a calling app starts
// the camera, so it must exist before that happens.
function ensureWantEvent(): boolean {
  if (S.hWant) return true;
  try {
    S.hWant = S.fn.CreateEventA(null, 0, 0, NAMES.WANT); // auto-reset, initially non-signaled
    return !!S.hWant;
  } catch { return false; }
}

// Open the receiver-created objects. Returns true once fully mapped & ready.
function ensureReady(): boolean {
  if (S.ready) return true;
  if (!ensureWantEvent()) return false;
  const f = S.fn;
  let mutex: any = null, sent: any = null, file: any = null, view: any = null;
  try {
    mutex = f.OpenMutexA(SYNCHRONIZE, 0, NAMES.MUTEX);
    if (!mutex) return false;
    sent = f.OpenEventA(EVENT_MODIFY_STATE, 0, NAMES.SENT);
    if (!sent) { f.CloseHandle(mutex); return false; }
    file = f.OpenFileMappingA(FILE_MAP_WRITE, 0, NAMES.DATA);
    if (!file) { f.CloseHandle(sent); f.CloseHandle(mutex); return false; }
    view = f.MapViewOfFile(file, FILE_MAP_WRITE, 0, 0, 0);
    if (!view) { f.CloseHandle(file); f.CloseHandle(sent); f.CloseHandle(mutex); return false; }
  } catch {
    try { if (view) f.UnmapViewOfFile(view); } catch {}
    try { if (file) f.CloseHandle(file); } catch {}
    try { if (sent) f.CloseHandle(sent); } catch {}
    try { if (mutex) f.CloseHandle(mutex); } catch {}
    return false;
  }
  S.hMutex = mutex; S.hSent = sent; S.hFile = file; S.view = view;
  S.ready = true;
  return true;
}

function toBuffer(x: any): Buffer | null {
  if (x instanceof ArrayBuffer) return Buffer.from(x);
  if (ArrayBuffer.isView(x)) {
    const v = x as ArrayBufferView;
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  }
  return null;
}

function sendFrame(pixels: Buffer, width: number, height: number): boolean {
  if (!S.active) return false;
  if (!ensureReady()) return false;

  const dataSize = width * height * 4;
  if (pixels.length !== dataSize) return false;
  const total = HEADER_SIZE + dataSize;

  // Read the receiver-set maxSize (offset 0) so we preserve it.
  const f = S.fn;
  try {
    if (!S.combined || S.combined.length < total) S.combined = Buffer.alloc(total);
    const head = S.combined;

    const tmp = Buffer.alloc(4);
    f.RtlMoveMemory(tmp, S.view, 4);
    const maxSize = tmp.readUInt32LE(0);
    S.maxSize = maxSize;
    if (maxSize !== 0 && dataSize > maxSize) return false; // too large

    head.writeUInt32LE(maxSize, 0);
    head.writeInt32LE(width, 4);
    head.writeInt32LE(height, 8);
    head.writeInt32LE(width, 12);            // stride in pixels (tightly packed)
    head.writeInt32LE(FORMAT_UINT8, 16);
    head.writeInt32LE(RESIZEMODE_LINEAR, 20);
    head.writeInt32LE(MIRRORMODE_HORIZONTAL, 24);
    head.writeInt32LE(FRAME_TIMEOUT_MS, 28);
    pixels.copy(head, HEADER_SIZE, 0, dataSize);

    // Serialize against the filter's read.
    const wait = f.WaitForSingleObject(S.hMutex, INFINITE_UNUSED);
    if (wait !== WAIT_OBJECT_0) return false; // busy / abandoned - skip this frame
    try {
      f.RtlMoveMemory(S.view, head, total);
    } finally {
      f.ReleaseMutex(S.hMutex);
    }
    f.SetEvent(S.hSent);
    return true;
  } catch {
    return false;
  }
}

export function initVirtualCameraIpc(ipcMain: IpcMain) {
  ipcMain.handle("vcam-start", () => {
    const ok = loadKoffi();
    if (!ok) return { supported: false, active: false, ready: false, error: S.error };
    S.active = true;
    ensureWantEvent();
    return { supported: true, active: true, ready: S.ready, error: S.error };
  });

  ipcMain.handle("vcam-stop", () => {
    S.active = false;
    closeHandles();
    S.combined = null;
    return { supported: S.supported, active: false, ready: false, error: S.error };
  });

  ipcMain.handle("vcam-status", () => ({
    supported: S.supported,
    active: S.active,
    ready: S.ready,
    error: S.error,
    cameraName: "Stream Studio Camera",
  }));

  // High-frequency frame pump (fire-and-forget).
  ipcMain.on("vcam-frame", (_e, buf: any, width: number, height: number) => {
    if (!S.active) return;
    const px = toBuffer(buf);
    if (!px) return;
    sendFrame(px, width | 0, height | 0);
  });
}

export function shutdownVirtualCamera() {
  try { S.active = false; closeHandles(); } catch {}
}
