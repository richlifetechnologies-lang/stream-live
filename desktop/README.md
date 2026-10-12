# Stream Live

Real-time AI webcam transformation powered by **Decart Lucy 2.1**.

Transform your live webcam feed into any of 9 AI styles in real-time — perfect for OBS streaming, content creation, and live video.

## Download

👉 **[Download latest Windows installer →](../../releases/latest)**

No Python, no Docker, no GPU required. Download, install, sign in, and stream.

## Features

- **9 AI Style Presets** — Hyper-Real, Anime, Cinematic, Cyberpunk, Fantasy, Horror, Neon Noir, Watercolor, Sketch
- **Real-time transformation** — powered by Decart Lucy 2.1 cloud inference
- **OBS-ready** — dedicated clean output window for OBS Window Capture
- **Audio Sync** — automatically delays microphone to match AI video lag
- **Fullscreen mode** — CSS-based, works in all contexts including sandboxed frames
- **Reference image** — guide the AI with a face reference image
- **Custom prompt** — describe the transformation you want
- **Multi-camera** — select from any connected webcam
- **Minutes-based access** — sign in with your account; the gateway hands out the AI access and meters your usage. You never handle an API key.

## Setup

1. Download and install Stream Live
2. Sign in with the account your administrator created for you
3. Check your minutes on the Minutes page (ask your administrator to top up when low)
4. Enable your camera → click **Stream Now**

You don't need your own AI service key. Access and billing are handled through
your account and the minutes your administrator grants you.

## Using with OBS

1. Start streaming in Stream Live first
2. In OBS: **Sources → + → Window Capture → Stream Live**
3. Toggle **Audio Sync ON** in the app's right panel
4. Do **not** add a separate mic source in OBS — Stream Live handles audio routing

## Building from source

```bash
git clone https://github.com/YOUR_USERNAME/stream-live.git
cd stream-live
npm install
npm run dev          # development (Vite only, browser)
npm run dist:win     # build Windows installer → release/
```

## Requirements

- Windows 10/11 x64
- Webcam
- Internet connection (for the AI gateway)
- An account from your administrator (sign in — no API key needed)

## Tech stack

- **Electron 33** — desktop wrapper
- **React 18 + Vite** — UI
- **Decart SDK** — real-time WebRTC streaming
- **electron-builder** — Windows NSIS installer
- **Tailwind CSS** — styling

## License

MIT
