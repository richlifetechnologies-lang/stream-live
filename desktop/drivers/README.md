# Stream Studio Virtual Drivers

Stream Studio exposes the AI output to other apps (Zoom, Teams, Chrome, Discord,
WhatsApp, …) through two virtual devices — **no OBS required**:

| Device | Type | Technology | What it carries |
|--------|------|-----------|-----------------|
| **Stream Studio Camera** | Video input | UnityCapture DirectShow filter (`virtual-camera/*.dll`) | The AI video output |
| **Stream Studio Microphone** | Audio input | VB-Audio Virtual Cable (`VBCable_Setup_x64.exe`) | The AI/cloned audio |

## How it works

- **Camera:** the UnityCapture filter registers as a normal webcam. While it is
  toggled ON in Stream Studio, the Electron main process writes each AI-output
  frame (RGBA8, 1280×720) into the filter's shared-memory buffer using the
  UnityCapture protocol (`UnityCapture_Data` + mutex/event handshake). The filter
  scales the frame (`resizemode=LINEAR`) to whatever resolution the calling app
  negotiated, so it works at 480p–4K.
- **Microphone:** VB-Cable creates a virtual audio cable. Toggling "Stream Studio
  Microphone" routes the AI audio to the cable input via `setSinkId`; the calling
  app records from the cable output.

## Installation

The Windows installer registers both devices automatically. To install, repair,
or remove them manually at any time:

```powershell
# from an Administrator PowerShell, in this folder
powershell -ExecutionPolicy Bypass -File .\Install-VirtualDevices.ps1              # install both
powershell -ExecutionPolicy Bypass -File .\Install-VirtualDevices.ps1 -NoAudio    # camera only
powershell -ExecutionPolicy Bypass -File .\Install-VirtualDevices.ps1 -Uninstall   # remove camera
```

The script **verifies** registration against the DirectShow registry and reports
real success/failure (it does not print a fake "[OK]").

## Using it in a call

1. In Stream Studio, turn on the **Broadcast to Calls** toggles (Camera /
   Microphone).
2. Start streaming so there is AI output to broadcast.
3. In Zoom/Teams/Chrome, pick **Stream Studio Camera** as the camera and
   **Stream Studio Microphone** (or "CABLE Output") as the microphone.

## Notes

- The virtual camera is a DirectShow device. Most Windows calling apps
  (Zoom, Teams, Skype, OBS, Discord, browsers via the DirectShow path) see it.
  A few Media-Foundation-only apps may not — that is a limitation of the free
  UnityCapture filter.
- These drivers are **unsigned**. Windows SmartScreen / "Windows protected your
  PC" may appear on first install; choose *More info → Run anyway*.
- OBS Studio is intentionally NOT bundled.
