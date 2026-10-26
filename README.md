# Stealth Interview Copilot Desktop (`interview-copilot-desktop`)

A cross-platform (Windows & macOS) desktop application built with **Electron + TypeScript + Vite** that provides real-time, on-device interview assistance with maximum stealth.

---

## 🚀 Key Features

1. **Native OS Audio Loopback Capture (Interviewer Only)**
   - Captures headphone / speaker audio output via Chromium's `setDisplayMediaRequestHandler` (using **WASAPI** on Windows and **ScreenCaptureKit** on macOS 13.2+).
   - Completely ignores the user's microphone so only the interviewer's questions are captured.
   - Detaches and halts all video tracks to consume 0% GPU/CPU for video processing.

2. **100% Local On-Device Whisper STT**
   - Transcribes recent interviewer audio locally using `Xenova/whisper-base.en` (or `whisper-tiny.en`) powered by ONNX Runtime / WebAssembly in a dedicated Web Worker.
   - Zero audio bytes leave the user's machine.
   - Real-time RMS-based Voice Activity Detection (VAD) and animated HUD VU meter.

3. **Stealth Overlay HUD**
   - **Screen-Capture Protected**: Uses `setContentProtection(true)` so the HUD is completely invisible to **Zoom, Microsoft Teams, Google Meet, Slack, and OBS** screen captures.
   - **Click-Through Mode**: Toggleable mouse pass-through (`⌘⇧M`) allowing direct clicks to fall through into your IDE or terminal.
   - **Frameless Glassmorphism Design**: High contrast typography, neon accents, dark acrylic blur, and window corner snapping.

4. **Silent Clipboard Ingestion & Global Hotkeys**
   - Reads copied problem statements, method signatures, and code without stealing focus.
   - Auto-detects programming languages (Java, Python, C++, TypeScript, SQL).

5. **Token-by-Token SSE Stream Rendering**
   - Streams live markdown answers from the companion `interview-copilot-api` proxy with syntax highlighting (`highlight.js`) and one-click code copying.

6. **Stealth Firebase Deep Linking (`copilot://`)**
   - Protocol-level silent authentication handoff via `copilot://auth?token=<customToken>`.
   - The OS **does not steal window focus** away from your coding IDE during browser redirect.
   - Sessions are persisted locally in IndexedDB via Firebase Client SDK.
   - Seamlessly injects dynamic `Authorization: Bearer <idToken>` headers into streaming solve requests.

---

## ⌨️ Global Stealth Hotkeys

| Hotkey | Action | Description |
| :--- | :--- | :--- |
| `⌘ + Shift + C` / `Ctrl + Shift + C` | **Capture Clipboard** | Silently reads OS clipboard text without taking window focus |
| `⌘ + Shift + Enter` / `Ctrl + Shift + Enter` | **Solve Problem** | Triggers AI generation using rolling transcript + code context |
| `⌘ + Shift + X` / `Ctrl + Shift + X` | **Reset Context** | Clears audio ring buffer, transcript, clipboard, and solution |
| `⌘ + Shift + H` / `Ctrl + Shift + H` | **Stealth Toggle** | Instantly hides or reveals the HUD overlay window |
| `⌘ + Shift + M` / `Ctrl + Shift + M` | **Pass-Through** | Toggles mouse click-through mode for underlying IDE interaction |
| `⌘ + Shift + Arrows` | **Snap Window** | Snaps the HUD overlay to screen corners or center |

---

## 📁 Directory Structure

```text
interview-copilot-desktop/
├── src/
│   ├── main/
│   │   ├── index.ts               # Electron Main bootstrap, window creation & IPC handlers
│   │   ├── stealthWindow.ts       # setContentProtection(true), alwaysOnTop, non-focusable & snap
│   │   ├── shortcuts.ts           # globalShortcut registrations (Clipboard, Solve, Clear, Move)
│   │   ├── audioLoopback.ts       # setDisplayMediaRequestHandler for OS loopback audio
│   │   └── apiProxyClient.ts      # SSE client communicating with interview-copilot-api
│   ├── preload/
│   │   ├── index.ts               # ContextBridge safe IPC exposure
│   │   └── index.d.ts             # TypeScript definitions
│   └── renderer/
│       ├── index.html             # HUD interface layout & status bar
│       ├── main.ts                # Audio pipeline, clipboard, SSE markdown rendering
│       ├── env.d.ts               # Global Window.electronAPI type augmentation
│       ├── audio/
│       │   ├── ringBuffer.ts      # 60s rolling PCM 16kHz float32 audio buffer with VAD
│       │   └── stt.worker.ts      # Whisper-base.en local transcription Web Worker
│       └── styles/
│           └── main.css           # Glassmorphism dark HUD styling
├── electron.vite.config.ts        # electron-vite multi-target build configuration
├── package.json
└── tsconfig.json
```

---

## 🛠️ Quick Start

### 1. Prerequisites
- **Node.js**: v20+ LTS
- Companion Backend: Default configured to production Render API (`https://interview-copilot-api-xhap.onrender.com`), or a local `interview-copilot-api` instance.

### 2. Install & Run
```bash
# In interview-copilot-desktop:
npm install

# Start in development mode with HMR:
npm run dev

# Build production bundle:
npm run build
```

### 3. Backend Connection
The desktop client is preconfigured to connect directly to the hosted Render service:
- **Default API URL**: `https://interview-copilot-api-xhap.onrender.com`
- **Render Free Tier**: On initial boot after idle sleep, container startup takes ~30–45s. The HUD proxy indicator will show `Proxy: Waking up...` until active.
- To point to a local backend instead, open Settings in the HUD and change the API URL to `http://localhost:3000`.

