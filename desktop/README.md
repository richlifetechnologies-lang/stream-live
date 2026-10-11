# Stream Studio

Real-time AI webcam transformation powered by **Decart Lucy 2.1**.

Transform your live webcam feed into any of 9 AI styles in real-time — perfect for OBS streaming, content creation, and live video.

## Download

👉 **[Download latest Windows installer →](../../releases/latest)**

No Python, no Docker, no GPU required. Download, install, enter your API key, and stream.

## Features

- **9 AI Style Presets** — Hyper-Real, Anime, Cinematic, Cyberpunk, Fantasy, Horror, Neon Noir, Watercolor, Sketch
- **Real-time transformation** — powered by Decart Lucy 2.1 cloud inference
- **OBS-ready** — dedicated clean output window for OBS Window Capture
- **Audio Sync** — automatically delays microphone to match AI video lag
- **Fullscreen mode** — CSS-based, works in all contexts including sandboxed frames
- **Reference image** — guide the AI with a face reference image
- **Custom prompt** — describe the transformation you want
- **Multi-camera** — select from any connected webcam
- **Your own API key** — stored locally on your device, never sent anywhere except Decart

## Setup

1. Get a Decart API key from [app.decart.ai](https://app.decart.ai)
2. Download and install Stream Studio
3. Enter your API key on first launch
4. Enable your camera → click **Stream Now**

## Using with OBS

1. Start streaming in Stream Studio first
2. In OBS: **Sources → + → Window Capture → Stream Studio**
3. Toggle **Audio Sync ON** in the app's right panel
4. Do **not** add a separate mic source in OBS — Stream Studio handles audio routing

## Building from source

```bash
git clone https://github.com/YOUR_USERNAME/stream-studio.git
cd stream-studio
npm install
npm run dev          # development (Vite only, browser)
npm run dist:win     # build Windows installer → release/
```

## Requirements

- Windows 10/11 x64
- Webcam
- Internet connection (for Decart API)
- [Decart API key](https://app.decart.ai)

## Tech stack

- **Electron 33** — desktop wrapper
- **React 18 + Vite** — UI
- **Decart SDK** — real-time WebRTC streaming
- **electron-builder** — Windows NSIS installer
- **Tailwind CSS** — styling

## License

MIT
