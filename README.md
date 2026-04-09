# voice-box

A local-first Electron desktop application for macOS that records calls and meetings, transcribes them in real time using local Whisper, identifies speakers via diarization, and lets you search and chat with your transcripts using a swappable LLM backend (Ollama, Claude, or OpenAI).

- **Fully offline capable** — transcription, diarization, embeddings, and chat all run locally with Ollama / Whisper
- **Privacy-first** — audio and transcripts never leave your machine unless you explicitly connect a cloud API
- **Zero subscription required** — bring your own API keys for cloud models, or use none at all

---

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Running in development](#running-in-development)
- [Building for production](#building-for-production)
- [Project structure](#project-structure)
- [Architecture overview](#architecture-overview)
- [Configuration & settings](#configuration--settings)
- [Running tests](#running-tests)
- [Contributing](#contributing)
- [Troubleshooting](#troubleshooting)

---

## Features

| Feature | Details |
|---|---|
| **Real-time transcription** | Chunked Whisper transcription via local Python subprocess |
| **Speaker diarization** | Pyannote.audio identifies and labels individual speakers |
| **Speaker profiles** | Voice embeddings auto-match returning speakers across recordings |
| **Semantic search** | Vector similarity search over your entire transcript corpus |
| **Conversational AI** | Ask questions about any recording or across all recordings |
| **Auto-debrief** | Structured meeting summary auto-generated after each recording |
| **Export** | Export transcripts as plain text, Markdown, or SRT subtitles |
| **LLM flexibility** | Swap between Ollama (local), Claude API, and OpenAI API at runtime |
| **TTS playback** | AI responses and transcript segments read aloud via macOS voices |

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| macOS | 12 Monterey+ | Audio capture uses CoreAudio / BlackHole |
| Node.js | 20.x LTS | `nvm install 20` recommended |
| Python | 3.11 | Used for Whisper and Pyannote subprocesses |
| Conda or venv | any | The setup script creates a managed Python env |
| Xcode CLT | latest | Required by `electron-rebuild` for native modules |
| BlackHole (optional) | 2ch | Virtual audio device for capturing system audio |

Install [BlackHole](https://existential.audio/blackhole/) if you want to record Zoom calls or any system audio (not just your microphone).

---

## Installation

```bash
# 1. Clone the repo
git clone https://github.com/<your-org>/voice-box.git
cd voice-box

# 2. Install Node dependencies
npm install

# 3. Rebuild native modules for the local Electron version
npm run rebuild

# 4. Set up the Python environment (Whisper + Pyannote)
npm run setup:python
```

`setup:python` creates a Python virtual environment at `python/venv/`, installs all dependencies from `python/requirements.txt`, and downloads the Whisper model weights. This can take a few minutes on first run.

> **Conda users:** The setup script respects an active conda environment. You can also point `PYTHON_BIN` at any Python 3.11+ executable before running the script.

---

## Running in development

```bash
npm run dev
```

This starts `electron-vite` in watch mode — the renderer hot-reloads on file changes, and the main process restarts automatically.

The app launches with a local SQLite database at:
```
~/Library/Application Support/call-transcriber/recordings.db
```

---

## Building for production

```bash
# Full production build (bundles Python env, then packages the Electron app)
npm run package
```

`npm run package` runs `setup:python` → `electron-vite build` → `electron-builder` and outputs a signed `.dmg` to `dist/`.

For a faster build without the Python bundling step (if the Python env is already set up):
```bash
npm run build         # electron-vite only
```

---

## Project structure

```
voice-box/
├── src/
│   ├── main/                   # Electron main process (Node.js)
│   │   ├── ipc/                # IPC handler registrations (one file per domain)
│   │   │   ├── recording.ipc.ts
│   │   │   ├── transcript.ipc.ts
│   │   │   ├── ai.ipc.ts
│   │   │   ├── speaker.ipc.ts
│   │   │   ├── search.ipc.ts
│   │   │   ├── settings.ipc.ts
│   │   │   └── voice.ipc.ts
│   │   ├── services/
│   │   │   ├── audio/          # AudioCaptureService (naudiodon)
│   │   │   ├── transcription/  # TranscriptionQueue + WhisperService
│   │   │   ├── storage/        # SQLite database + repositories
│   │   │   │   └── repositories/
│   │   │   │       ├── RecordingRepository.ts
│   │   │   │       ├── TranscriptRepository.ts
│   │   │   │       ├── SpeakerRepository.ts
│   │   │   │       ├── ConversationRepository.ts
│   │   │   │       └── SettingsRepository.ts
│   │   │   ├── llm/            # LLMService + provider adapters
│   │   │   ├── ai/             # IntentClassifier (speaker labeling commands)
│   │   │   ├── search/         # SearchService (vector + FTS5)
│   │   │   ├── security/       # Keytar-backed API key storage
│   │   │   └── python/         # Python subprocess bridge
│   │   └── __tests__/          # Vitest unit tests (main process)
│   ├── renderer/               # Electron renderer process (React)
│   │   └── src/
│   │       ├── pages/          # Top-level route pages
│   │       │   ├── Dashboard.tsx
│   │       │   ├── RecordingPage.tsx
│   │       │   ├── GlobalChatPage.tsx
│   │       │   ├── SearchPage.tsx
│   │       │   ├── SpeakersPage.tsx
│   │       │   └── SettingsPage.tsx
│   │       ├── components/     # Shared UI components
│   │       └── stores/         # Zustand state stores
│   ├── preload/                # Electron contextBridge (typed IPC exposure)
│   └── shared/
│       ├── types.ts            # Shared TypeScript types
│       └── ipc-types.ts        # IPC channel names + payload types
├── python/
│   ├── transcribe.py           # Whisper subprocess entry point
│   ├── diarize.py              # Pyannote diarization subprocess
│   ├── embed_voice.py          # Speaker voice embedding subprocess
│   └── requirements.txt
├── scripts/
│   └── setup_python_env.sh     # One-shot Python env bootstrap
├── tests/
│   └── e2e/                    # Playwright end-to-end tests
├── resources/                  # App icons and static assets
├── electron.vite.config.ts
├── vitest.config.ts
└── playwright.config.ts
```

---

## Architecture overview

voice-box follows a strict **main / renderer separation** enforced by Electron's process model.

```
Renderer (React UI)
        │
        │  contextBridge — typed IPC (src/preload/)
        ▼
Main Process (Node.js)
        │
        ├── IPC handlers   — thin layer, delegates to services
        ├── Services        — all business logic lives here
        │   ├── AudioCaptureService   — naudiodon mic/loopback capture
        │   ├── TranscriptionQueue    — buffers PCM chunks → Whisper subprocess
        │   ├── WhisperService        — Python bridge for local Whisper
        │   ├── Repositories          — SQLite read/write (better-sqlite3)
        │   ├── LLMService            — unified adapter (Ollama / Claude / OpenAI)
        │   └── SearchService         — sqlite-vec vector search + FTS5
        └── Python subprocesses
                ├── transcribe.py     — Whisper (local)
                └── diarize.py        — Pyannote speaker diarization
```

**Key design rules:**
- IPC handlers are thin — they validate input, call a service, and return. No business logic in handlers.
- Repositories own all SQL. No raw queries outside `src/main/services/storage/`.
- The LLM layer is fully swappable at runtime — `LLMService.complete(feature, request)` picks the right provider from settings automatically.
- The renderer never touches the filesystem or native APIs directly.

---

## Configuration & settings

All settings are persisted to the local SQLite database (not `~/.env`). Open **Settings** in the sidebar to configure:

| Setting | Description |
|---|---|
| **Audio input device** | Microphone or virtual audio device (BlackHole) |
| **Whisper model** | `tiny` / `base` / `small` / `medium` / `large` — larger = slower but more accurate |
| **LLM provider** | Ollama (local), OpenAI, or Anthropic Claude |
| **OpenAI API key** | Stored encrypted via macOS Keychain (keytar) |
| **Anthropic API key** | Same — never written to disk in plaintext |
| **Ollama base URL** | Default `http://localhost:11434` |
| **TTS voice** | Any installed macOS `say` voice |

### Using Ollama (recommended for full local operation)

1. Install [Ollama](https://ollama.ai) and start it: `ollama serve`
2. Pull a model: `ollama pull llama3` (or any model you prefer)
3. In Settings → LLM Provider, select **Ollama** and set the model name

---

## Running tests

### Unit tests (Vitest)

```bash
npm test                  # run once
npm run test:watch        # watch mode
npm run test:coverage     # with coverage report
```

Unit tests live in `src/main/__tests__/`. They test:
- All repository CRUD operations (in-memory SQLite)
- All IPC handler logic (mocked dependencies)
- `TranscriptionQueue` pipeline
- `IntentClassifier` speaker labeling parser

> **Note:** Tests that use `better-sqlite3` require the native module to be compiled for the same Node.js version running Vitest. Run `npm run rebuild` if you see `ERR_DLOPEN_FAILED`.

### End-to-end tests (Playwright)

```bash
npm run build             # required — E2E tests run against the built app
npm run test:e2e          # run all E2E specs
npm run test:e2e:ui       # interactive Playwright UI
```

E2E tests live in `tests/e2e/` and cover navigation, recording controls, transcript view, speaker assignment UI, chat, search, and settings.

---

## Contributing

### Adding a new feature

1. **Types first** — Add any new shared types to `src/shared/types.ts` and IPC contracts to `src/shared/ipc-types.ts`.
2. **Repository** — If the feature needs persistence, add methods to the relevant repository in `src/main/services/storage/repositories/`. Write repository unit tests alongside.
3. **Service** — Business logic goes in `src/main/services/`. Keep services free of Electron imports so they are easily unit-testable.
4. **IPC handler** — Add a thin handler in `src/main/ipc/`. Register it in `src/main/index.ts`. Write IPC handler tests using the capture-handler pattern (see `recording-ipc.test.ts` for an example).
5. **Preload** — Expose new channels in `src/preload/index.ts` via `contextBridge`.
6. **Renderer** — Add the UI in `src/renderer/src/`. State goes in a Zustand store; side effects via the typed IPC wrapper.

### IPC handler test pattern

IPC handlers are injected with their dependencies so they are fully testable without Electron running:

```ts
// Capture handlers registered with ipcMain.handle
const handlers: Record<string, Function> = {}
vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
  handlers[channel] = handler
  return ipcMain
})

registerMyIpc(mockDeps)

// Invoke directly
const result = await handlers['my:channel']({} as IpcMainInvokeEvent, args)
```

### Code style

- TypeScript strict mode — no `any` in shared types or IPC payloads
- Repositories use `better-sqlite3` synchronous API only
- React components are functional with hooks
- Zustand stores for renderer state — no Redux, no Context for global state

### Running a lint + type check before committing

```bash
npm run lint
npm run typecheck
```

---

## Troubleshooting

**`ERR_DLOPEN_FAILED` when running tests**
Native modules (`better-sqlite3`, `naudiodon`) must be compiled for the exact Node.js version and Electron version in use. Run:
```bash
npm run rebuild
```

**Whisper subprocess crashes on first run**
The Python environment may not have downloaded model weights. Run `npm run setup:python` again. Weights are cached in `python/venv/` after first download.

**No audio devices listed in Settings**
`naudiodon` requires microphone permission on macOS. Open System Settings → Privacy & Security → Microphone and enable the app.

**BlackHole not showing as an input device**
Install [BlackHole 2ch](https://existential.audio/blackhole/), then create a Multi-Output Device in macOS Audio MIDI Setup that combines BlackHole with your speakers.

**Ollama responses time out**
Ensure Ollama is running (`ollama serve`) and the model is pulled (`ollama list`). Check the base URL in Settings matches your Ollama instance (default: `http://localhost:11434`).

