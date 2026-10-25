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
- `--bridge-gap`: Maximum gap in seconds to bridge into continuous scene blocks (default: `3.5`).
- `--scene-conf`: Intimate scene confidence threshold (default: `0.40`).
- `--part-conf`: Anatomical part confidence threshold (default: `0.35`).
- `--clip-conf`: CLIP zero-shot prompt confidence threshold (default: `0.60`).
- `--output`: Path to export structured timeline JSON (default: `timeline.json`).
- `--clip-output`: Path to export raw CLIP text descriptions JSON (default: `clip_descriptions.json`).
- `--output-video`: Target video file with embedded chapters (default: `[name]_with_chapters.mp4`).

---

## 🌐 Browser MP4 Smart Player with Custom Auto-Skip

The system includes a dedicated local browser player (`player_server.py`) with a modern dark glassmorphism interface:

### Player Highlights:
- **Automatic Scene Skipping**: Automatically fast-forwards past detected violations as the video plays.
- **Customizable Skip Settings**: Toggle buttons for each specific category (e.g. choose to auto-skip Nudity & Kissing, but allow Violence or Smoking).
- **Master Auto-Skip Switch**: Turn automatic skipping on/off with one click.
- **Visual Seekbar Segments**: Color-coded segments along the timeline bar showing where flagged scenes occur.
- **Interactive Scene Navigator**: List of all detected scenes with timestamps and confidence scores. Click any scene to jump immediately.
- **Local File Support**: Open any local video or custom `timeline.json` file directly inside the browser.

### Starting the Player:
```bash
python player_server.py
```
Open **[http://localhost:8888](http://localhost:8888)** in your browser.
