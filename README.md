# Video Content Moderation System

A Computer Vision and Vision-Language system that inspects video files for temporal violations—including explicit nudity, exposed anatomical parts, intimate/sensual scenes, physical violence, gunfire/explosions, blood/gore, and tobacco smoking or alcohol consumption.

## Features

- **Multi-Stage Detection Engine**:
  - **OpenCLIP (`ViT-B-32`)**: Vision-language text embeddings for zero-shot detection of romantic intimacy, kissing, fighting, gunfire/blasts, blood stains, and cigarette smoking (active smoking, holding in hand, or cigarette in mouth).
  - **Falconsai NSFW Image Detection**: Full-scene classification for holistic intimate and suggestive context.
  - **NudeNet ONNX**: High-precision anatomical detector for strictly exposed body parts (exposed breasts/nipples, buttocks, genitalia, bare midriff/bareback).
- **Temporal Event Debouncing & Overlap Merging**:
  - Eliminates micro-fragmentation caused by camera shifts.
  - Merges overlapping concurrent events into unified parent scenes with nested `sub_events`.
- **Native MP4 Video Chapters**:
  - Uses FFmpeg to losslessly inject continuous seekbar chapters (including `"Normal Scene"`) directly into the video container.
- **Detailed JSON Outputs**:
  - `timeline.json`: Hierarchical event intervals with timestamps, duration, peak confidence, and nested sub-events.
  - `clip_descriptions.json`: Per-second raw prompt probability distributions and top descriptions.
- **Interactive Terminal Progress Bar**:
  - Real-time in-place progress indicator with percentage, elapsed time, ETA countdown, and active violation count.

## Installation

```bash
pip install torch torchvision ultralytics opencv-python-headless nudenet onnxruntime open_clip_torch transformers imageio-ffmpeg
```

## Usage

```bash
python adult_moderation.py "path/to/video.mp4" --fps-sample 1.0 --output timeline.json --clip-output clip_descriptions.json
```

### CLI Options:
- `--fps-sample`: Number of frames to sample per second (default: `1.0`).
- `--batch-size`: Batch size of sampled frames fed into the CLIP image encoder simultaneously (e.g. `8`, `16`, `32`; default: `16`).
- `--models`: Comma-separated list of active models to execute: `'scene'`, `'nudenet'`, `'clip'`, or `'all'` (default: `'scene,nudenet,clip'`).
- `--no-scene`: Flag to disable Falconsai NSFW scene classifier.
- `--no-nudenet`: Flag to disable NudeNet anatomical body part detector.
- `--no-clip`: Flag to disable OpenCLIP vision-language model.
- `--bridge-gap`: Maximum gap in seconds to bridge into continuous scene blocks (default: `3.5`).
- `--scene-conf`: Intimate scene confidence threshold (default: `0.40`).
- `--part-conf`: Anatomical part confidence threshold (default: `0.35`).
- `--clip-conf`: CLIP zero-shot prompt confidence threshold (default: `0.60`).
- `--output`: Path to export structured timeline JSON (default: `timeline.json`).
- `--clip-output`: Path to export raw CLIP text descriptions JSON (default: `clip_descriptions.json`).
- `--output-video`: Target video file with embedded chapters (default: `[name]_with_chapters.mp4`).


---

## 🚀 Next.js OTT-Grade Web Player (`web/`)

A modern, high-performance Next.js OTT web player built with React, App Router, and TailwindCSS:

### OTT Player Features:
- **OTT Controls**: Clean, minimal cinema UI with **-5s** and **+5s** skip forward/backward buttons, keyboard shortcuts (`Space` to toggle play/pause, `←` / `→` for 5s jumps, `M` to mute, `F` for fullscreen).
- **Dynamic Category Auto-Skip**: Toggles for individual categories (Nudity, Intimacy, Violence, Gunfire/Explosions, Blood/Gore, Smoking, Alcohol). The player dynamically unions and merges overlapping intervals on the fly.
- **Color-Coded Violation Seekbar**: Visual color segments overlaid on the timeline with timestamps.
- **HTTP 206 Partial Content Streaming**: Native Next.js API route (`/api/stream`) for video streaming and seeking.
- **Local Video/Timeline File Pickers**: Switch video or custom category-wise `timeline.json` on demand.

### Running Next.js Player:
```bash
cd web
npm install
npm run dev
```
Open **[http://localhost:3000](http://localhost:3000)** in your browser.
