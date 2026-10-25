"""
Comprehensive Video Content Moderation System with Overlapping Interval Merging
and Continuous Full-Timeline Chapter Metadata.

Key Highlights:
1. Complete Overlap Interval Merging:
   - Any intervals that overlap in time (e.g., Kissing from 30s-90s and Bed Scene from 41s-63s)
     are merged into a single consolidated master scene (30s-90s) whose primary label reflects
     the most severe violation and whose `sub_events` contain all overlapping constituent details.
2. Full Gap-Free Video Chapters:
   - Intervening safe/unflagged periods are explicitly tagged as "Normal / Safe Content".
   - Viewers can jump between "Normal Scene" and "Intimate / Nude Scene" across the entire video seekbar.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

import cv2
import imageio_ffmpeg
import numpy as np
import open_clip
from PIL import Image
import torch
from transformers import pipeline
from nudenet import NudeDetector


CATEGORY_LABELS = {
    "FEMALE_GENITALIA_EXPOSED": "Exposed Genitalia",
    "MALE_GENITALIA_EXPOSED": "Exposed Genitalia",
    "FEMALE_BREAST_EXPOSED": "Exposed Breast / Nipple",
    "BUTTOCKS_EXPOSED": "Exposed Buttocks",
    "VIOLENCE": "Violence / Physical Fight",
    "GUNFIRE_EXPLOSION": "Gunfire / Explosion / Weapons",
    "BLOOD_GORE": "Blood / Gore / Injury",
    "INTIMATE_SCENE": "Intimate / NSFW Scene",
    "ROMANCE_KISS": "Kissing / Romantic Intimacy",
    "SMOKING": "Cigarette / Tobacco Smoking",
    "ALCOHOL": "Alcohol Consumption / Drinking",
    "BELLY_EXPOSED": "Bareback / Exposed Midriff",
    "ARMPITS_EXPOSED": "Exposed Skin / Armpits",
}

# Severity rank for primary scene label choice
SEVERITY_ORDER = {
    "FEMALE_GENITALIA_EXPOSED": 100,
    "MALE_GENITALIA_EXPOSED": 100,
    "FEMALE_BREAST_EXPOSED": 90,
    "BUTTOCKS_EXPOSED": 80,
    "BLOOD_GORE": 78,
    "GUNFIRE_EXPLOSION": 76,
    "VIOLENCE": 75,
    "INTIMATE_SCENE": 70,
    "ROMANCE_KISS": 60,
    "SMOKING": 55,
    "ALCOHOL": 52,
    "BELLY_EXPOSED": 50,
    "ARMPITS_EXPOSED": 30,
}


@dataclass
class ActiveEvent:
    category: str
    label_display: str
    start_frame: int
    last_detected_frame: int
    peak_confidence: float
    gap_count: int = 0


def format_seconds(seconds: float) -> float:
    return round(float(seconds), 2)


def sanitize_filename(name: str) -> str:
    return re.sub(r"[^\w\-_\. ]", "_", name).replace(" ", "_")


def merge_adjacent_events(
    events: List[Dict[str, Any]],
    max_merge_gap_sec: float = 3.5,
) -> List[Dict[str, Any]]:
    """
    Merges adjacent fragments belonging to the same category within max_merge_gap_sec.
    """
    if not events:
        return []

    events_by_cat: Dict[str, List[Dict[str, Any]]] = {}
    for ev in events:
        cat = ev["raw_label"]
        events_by_cat.setdefault(cat, []).append(ev)

    merged_all: List[Dict[str, Any]] = []

    for cat, cat_events in events_by_cat.items():
        cat_events.sort(key=lambda x: x["start_time"])
        merged_cat: List[Dict[str, Any]] = []

        curr = cat_events[0].copy()
        for next_ev in cat_events[1:]:
            if next_ev["start_time"] <= (curr["end_time"] + max_merge_gap_sec):
                curr["end_time"] = max(curr["end_time"], next_ev["end_time"])
                curr["peak_confidence"] = max(curr["peak_confidence"], next_ev["peak_confidence"])
            else:
                merged_cat.append(curr)
                curr = next_ev.copy()

        merged_cat.append(curr)
        merged_all.extend(merged_cat)

    merged_all.sort(key=lambda x: (x["start_time"], x["end_time"]))
    return merged_all


def merge_overlapping_intervals(
    events: List[Dict[str, Any]],
    tolerance_sec: float = 2.0,
) -> List[Dict[str, Any]]:
    """
    Finds ANY intervals that overlap in time (even across different categories)
    and merges them into a single overarching master scene.
    Nested sub-events are placed inside `sub_events`.
    """
    if not events:
        return []

    # Sort all raw events purely by start_time
    sorted_events = sorted(events, key=lambda x: (x["start_time"], x["end_time"]))

    merged_clusters: List[Dict[str, Any]] = []

    for ev in sorted_events:
        item = {
            "content_type": ev["content_type"],
            "raw_label": ev["raw_label"],
            "start_time": ev["start_time"],
            "end_time": ev["end_time"],
            "peak_confidence": ev["peak_confidence"],
        }

        if not merged_clusters:
            merged_clusters.append({
                "start_time": item["start_time"],
                "end_time": item["end_time"],
                "items": [item],
            })
            continue

        prev = merged_clusters[-1]
        # Overlapping condition: item starts before or within tolerance of previous cluster's end
        if item["start_time"] <= (prev["end_time"] + tolerance_sec):
            prev["end_time"] = max(prev["end_time"], item["end_time"])
            prev["items"].append(item)
        else:
            merged_clusters.append({
                "start_time": item["start_time"],
                "end_time": item["end_time"],
                "items": [item],
            })

    # Format each cluster into a primary master scene with nested sub-events
    final_master_scenes: List[Dict[str, Any]] = []

    for cluster in merged_clusters:
        items = cluster["items"]
        # Find item with highest severity to serve as primary scene label
        primary_item = max(
            items,
            key=lambda x: (SEVERITY_ORDER.get(x["raw_label"], 0), x["peak_confidence"]),
        )

        # Sub-events are all constituent items
        sub_events = [
            i for i in items
            if not (i["raw_label"] == primary_item["raw_label"]
                    and i["start_time"] == primary_item["start_time"]
                    and i["end_time"] == primary_item["end_time"])
        ]
        sub_events.sort(key=lambda x: x["start_time"])

        master_scene = {
            "content_type": primary_item["content_type"],
            "raw_label": primary_item["raw_label"],
            "start_time": format_seconds(cluster["start_time"]),
            "end_time": format_seconds(cluster["end_time"]),
            "peak_confidence": round(float(max(i["peak_confidence"] for i in items)), 4),
            "sub_events": sub_events,
        }
        final_master_scenes.append(master_scene)

    final_master_scenes.sort(key=lambda x: x["start_time"])
    return final_master_scenes


def embed_video_chapters(
    input_video: Path,
    output_video: Path,
    timeline: List[Dict[str, Any]],
    total_duration_sec: float,
) -> None:
    """
    Creates complete, gap-free video chapters spanning the entire video.
    Gaps between flagged scenes are explicitly marked as 'Normal Scene'.
    """
    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()

    # Build continuous sequence of chapters from 0 to total_duration_sec
    chapters: List[Dict[str, Any]] = []
    current_time = 0.0

    for item in timeline:
        s = float(item["start_time"])
        e = float(item["end_time"])

        # If there is a gap between current_time and the start of this flagged scene, insert Normal Scene
        if s > current_time + 0.5:
            chapters.append({
                "start_time": format_seconds(current_time),
                "end_time": format_seconds(s),
                "title": "Normal Scene",
            })

        # Construct informative title for the flagged interval
        title = item["content_type"]
        if item.get("sub_events"):
            sub_types = list(dict.fromkeys(
                sub["content_type"] for sub in item["sub_events"]
                if sub["content_type"] != item["content_type"]
            ))
            if sub_types:
                title += f" ({', '.join(sub_types[:2])})"

        chapters.append({
            "start_time": format_seconds(s),
            "end_time": format_seconds(e),
            "title": title,
        })
        current_time = max(current_time, e)

    # Trailing normal scene if video continues after last flagged event
    if total_duration_sec > current_time + 0.5:
        chapters.append({
            "start_time": format_seconds(current_time),
            "end_time": format_seconds(total_duration_sec),
            "title": "Normal Scene",
        })

    # Generate FFMETADATA
    lines = [";FFMETADATA1", "major_brand=isom", "minor_version=512", "compatible_brands=isomiso2avc1mp41"]
    for ch in chapters:
        start_ms = int(ch["start_time"] * 1000)
        end_ms = int(ch["end_time"] * 1000)
        if end_ms <= start_ms:
            end_ms = start_ms + 1000

        lines.extend([
            "[CHAPTER]",
            "TIMEBASE=1/1000",
            f"START={start_ms}",
            f"END={end_ms}",
            f"title={ch['title']}",
        ])

    metadata_text = "\n".join(lines) + "\n"

    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".txt", encoding="utf-8") as meta_f:
        meta_f.write(metadata_text)
        meta_file_path = meta_f.name

    try:
        cmd = [
            ffmpeg_exe,
            "-y",
            "-i", str(input_video),
            "-i", meta_file_path,
            "-map_metadata", "1",
            "-codec", "copy",
            str(output_video),
        ]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if res.returncode != 0:
            print(f"[Chapter Embedding Error] {res.stderr}")
        else:
            print(f"[Chapter Metadata] Embedded {len(chapters)} seamless chapters across the entire timeline into '{output_video}'!")
    finally:
        Path(meta_file_path).unlink(missing_ok=True)


def process_video_moderation_full(
    video_path: str | Path,
    sample_rate_fps: float = 1.0,
    scene_conf_threshold: float = 0.40,
    part_conf_threshold: float = 0.35,
    clip_conf_threshold: float = 0.60,
    bridge_gap_sec: float = 3.5,
    min_duration_sec: float = 0.5,
    include_covered: bool = True,
    use_scene_model: bool = True,
    use_nudenet_model: bool = True,
    use_clip_model: bool = True,
    clip_batch_size: int = 16,
    embed_chapters: bool = True,
    output_video_path: Optional[str | Path] = None,
    output_json_path: Optional[str | Path] = None,
    output_clip_json_path: Optional[str | Path] = None,
) -> List[Dict[str, Any]]:
    video_path = Path(video_path)
    if not video_path.exists():
        raise FileNotFoundError(f"Video file not found at: {video_path}")

    # Backward compatibility: if use_clip was passed or models all disabled
    if not (use_scene_model or use_nudenet_model or use_clip_model):
        print("[Warning] No models selected! Enabling CLIP by default.")
        use_clip_model = True

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise ValueError(f"OpenCV failed to open video file: {video_path}")

    try:
        video_fps = cap.get(cv2.CAP_PROP_FPS)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        if video_fps <= 0.0 or not (0 < video_fps < 1000):
            video_fps = 24.0

        duration_sec = total_frames / video_fps
        print(f"\n[Video Ingestion] Video FPS: {video_fps:.2f} | Total Frames: {total_frames} | Duration: {duration_sec:.1f}s (~{int(duration_sec//60)}m {int(duration_sec%60)}s)")

        frame_step = max(1, round(video_fps / sample_rate_fps))
        expected_samples = total_frames // frame_step
        max_gap_steps = max(2, round(bridge_gap_sec * sample_rate_fps))

        print(f"[Sampling Strategy] Rate: {sample_rate_fps:.1f} FPS (every {frame_step} frames). Smoothing: {bridge_gap_sec}s.")
        print(f"[Active Models] Scene Classifier: {use_scene_model} | NudeNet Detector: {use_nudenet_model} | OpenCLIP: {use_clip_model} (Batch Size: {clip_batch_size})")

        device = "cuda" if torch.cuda.is_available() else "cpu"

        scene_pipe = None
        if use_scene_model:
            print("[Model Loading] 1/3: Initializing Falconsai NSFW Scene Classifier...")
            scene_device = 0 if device == "cuda" else -1
            scene_pipe = pipeline("image-classification", model="Falconsai/nsfw_image_detection", device=scene_device)
        else:
            print("[Model Loading] 1/3: Falconsai NSFW Scene Classifier [DISABLED]")

        part_detector = None
        if use_nudenet_model:
            print("[Model Loading] 2/3: Initializing NudeNet Anatomical Part Detector...")
            part_detector = NudeDetector()
        else:
            print("[Model Loading] 2/3: NudeNet Anatomical Part Detector [DISABLED]")

        clip_model, clip_preprocess, clip_text_features, prompt_texts = None, None, None, []
        clip_logs: List[Dict[str, Any]] = []
        if use_clip_model:
            print(f"[Model Loading] 3/3: Initializing OpenCLIP ViT-B-32 Vision-Language Engine on {device.upper()}...")
            clip_model, _, clip_preprocess = open_clip.create_model_and_transforms(
                "ViT-B-32", pretrained="laion2b_s34b_b79k"
            )
            clip_model = clip_model.to(device)
            clip_model.eval()
            tokenizer = open_clip.get_tokenizer("ViT-B-32")
            prompt_texts = [
                "a photo of passionate kissing or romantic intimacy",
                "a photo of sensual foreplay or sexual act",
                "a photo of nudity, bare skin, naked body or undressing",
                "a photo of a regular movie scene or normal conversation with clothed people",
                "a photo of violence, physical fight, assault or beating",
                "a photo of gun fire, shooting with guns, explosion, blast or weapons",
                "a photo of blood stains, injury, wound or gory scene",
                "a photo of smoking a cigarette, cigar, vape, exhaling smoke, cigarette in mouth, holding a cigarette or lighter",
                "a photo of drinking alcohol, wine, beer, whiskey, holding an alcoholic drink or liquor bottle",
            ]
            clip_text_tokens = tokenizer(prompt_texts).to(device)
            with torch.no_grad():
                clip_text_features = clip_model.encode_text(clip_text_tokens)
                clip_text_features /= clip_text_features.norm(dim=-1, keepdim=True)
        else:
            print("[Model Loading] 3/3: OpenCLIP Vision-Language Engine [DISABLED]")

        print("[Model Loading] Initialized models successfully.\n")

        # Strictly bare skin / exposed anatomical parts (never fully clothed)
        tracked_part_keys = [
            "FEMALE_BREAST_EXPOSED",
            "FEMALE_GENITALIA_EXPOSED",
            "MALE_GENITALIA_EXPOSED",
            "BUTTOCKS_EXPOSED",
            "BELLY_EXPOSED",
        ]

        all_tracked_keys = []
        if use_scene_model:
            all_tracked_keys.append("INTIMATE_SCENE")
        if use_clip_model:
            all_tracked_keys.extend([
                "ROMANCE_KISS",
                "VIOLENCE",
                "GUNFIRE_EXPLOSION",
                "BLOOD_GORE",
                "SMOKING",
                "ALCOHOL",
            ])
            # If scene classifier is off, CLIP prompt 2 ("a photo of nudity, bare skin, naked body...") can also flag INTIMATE_SCENE
            if "INTIMATE_SCENE" not in all_tracked_keys:
                all_tracked_keys.append("INTIMATE_SCENE")
        if use_nudenet_model:
            all_tracked_keys.extend(tracked_part_keys)

        active_events: Dict[str, Optional[ActiveEvent]] = {k: None for k in all_tracked_keys}
        raw_timeline: List[Dict[str, Any]] = []

        interval_frames = frame_step

        def close_event(key: str) -> None:
            event = active_events[key]
            if not event:
                return

            start_sec = event.start_frame / video_fps
            end_sec = (event.last_detected_frame + interval_frames) / video_fps
            duration = end_sec - start_sec

            if duration >= min_duration_sec:
                raw_timeline.append(
                    {
                        "content_type": event.label_display,
                        "raw_label": key,
                        "start_time": format_seconds(start_sec),
                        "end_time": format_seconds(end_sec),
                        "peak_confidence": round(float(event.peak_confidence), 4),
                    }
                )

            active_events[key] = None

        frame_idx = 0
        samples_processed = 0
        start_time = time.time()

        # Batch container for sampled frames
        batch_items: List[Dict[str, Any]] = []

        def process_batch(items: List[Dict[str, Any]]) -> None:
            nonlocal samples_processed
            if not items:
                return

            batch_count = len(items)

            # 1. OpenCLIP Batch Inference (Batched Tensor encoding)
            clip_batch_results = []
            if use_clip_model and clip_model is not None and clip_preprocess is not None:
                # Stack preprocessed PIL images into a single chunk/tensor
                tensors = [clip_preprocess(it["pil_img"]) for it in items]
                batch_tensor = torch.stack(tensors).to(device)

                with torch.no_grad():
                    image_features = clip_model.encode_image(batch_tensor)
                    image_features /= image_features.norm(dim=-1, keepdim=True)
                    # Batch matrix multiplication: (B x D) @ (D x T) -> (B x T)
                    similarity_matrix = (100.0 * image_features @ clip_text_features.T).softmax(dim=-1).cpu().tolist()

                for i, it in enumerate(items):
                    sim = similarity_matrix[i]
                    scores_by_prompt = {prompt: round(float(sim[p_idx]), 4) for p_idx, prompt in enumerate(prompt_texts)}
                    best_match = max(scores_by_prompt.items(), key=lambda x: x[1])

                    curr_sec = format_seconds(it["frame_idx"] / video_fps)
                    clip_logs.append({
                        "timestamp_sec": curr_sec,
                        "top_description": best_match[0],
                        "top_confidence": best_match[1],
                        "all_prompt_scores": scores_by_prompt,
                    })

                    clip_batch_results.append(sim)
            else:
                clip_batch_results = [None] * batch_count

            # Process each frame in the batch with scene, nudenet and accumulated clip results
            for idx, it in enumerate(items):
                samples_processed += 1
                current_detections: Dict[str, float] = {}
                f_idx = it["frame_idx"]
                pil_img = it["pil_img"]
                frame_bgr = it["frame_bgr"]

                # A. Falconsai Scene Classifier
                if use_scene_model and scene_pipe is not None:
                    scene_preds = scene_pipe(pil_img)
                    for p in scene_preds:
                        if p["label"].lower() == "nsfw" and p["score"] >= scene_conf_threshold:
                            current_detections["INTIMATE_SCENE"] = float(p["score"])

                # B. CLIP detections from batch calculation
                sim = clip_batch_results[idx]
                if sim is not None:
                    # Romance / Intimacy probability (kissing or foreplay)
                    intimate_prob = max(sim[0], sim[1])
                    if intimate_prob >= clip_conf_threshold:
                        current_detections["ROMANCE_KISS"] = float(intimate_prob)

                    # Nudity / bare skin from prompt 2 if scene model is disabled
                    nudity_prompt_prob = sim[2]
                    if not use_scene_model and nudity_prompt_prob >= clip_conf_threshold:
                        current_detections["INTIMATE_SCENE"] = float(nudity_prompt_prob)

                    # Violence (prompt 4)
                    violence_prob = sim[4]
                    if violence_prob >= clip_conf_threshold:
                        current_detections["VIOLENCE"] = float(violence_prob)

                    # Gunfire / Explosion (prompt 5)
                    gunfire_prob = sim[5]
                    if gunfire_prob >= clip_conf_threshold:
                        current_detections["GUNFIRE_EXPLOSION"] = float(gunfire_prob)

                    # Blood / Gore (prompt 6)
                    blood_prob = sim[6]
                    if blood_prob >= clip_conf_threshold:
                        current_detections["BLOOD_GORE"] = float(blood_prob)

                    # Smoking (prompt 7)
                    smoking_prob = sim[7]
                    effective_smoking_threshold = min(clip_conf_threshold, 0.48)
                    if smoking_prob >= effective_smoking_threshold:
                        current_detections["SMOKING"] = float(smoking_prob)

                    # Alcohol (prompt 8)
                    alcohol_prob = sim[8]
                    if alcohol_prob >= clip_conf_threshold:
                        current_detections["ALCOHOL"] = float(alcohol_prob)

                # C. NudeNet Anatomical Part Detector
                if use_nudenet_model and part_detector is not None:
                    part_preds = part_detector.detect(frame_bgr)
                    for det in part_preds:
                        cls_name = det["class"]
                        score = float(det["score"])
                        if cls_name in tracked_part_keys and score >= part_conf_threshold:
                            if cls_name not in current_detections or score > current_detections[cls_name]:
                                current_detections[cls_name] = score

                # D. State Machine Update
                for key in all_tracked_keys:
                    current_event = active_events.get(key)
                    is_hit = key in current_detections
                    display_name = CATEGORY_LABELS.get(key, key)

                    if is_hit:
                        conf = current_detections[key]
                        if current_event is None:
                            active_events[key] = ActiveEvent(
                                category=key,
                                label_display=display_name,
                                start_frame=f_idx,
                                last_detected_frame=f_idx,
                                peak_confidence=conf,
                                gap_count=0,
                            )
                        else:
                            current_event.last_detected_frame = f_idx
                            current_event.gap_count = 0
                            if conf > current_event.peak_confidence:
                                current_event.peak_confidence = conf
                    else:
                        if current_event is not None:
                            current_event.gap_count += 1
                            if current_event.gap_count > max_gap_steps:
                                close_event(key)

                # Dynamic terminal progress bar
                elapsed = time.time() - start_time
                progress_ratio = min(1.0, samples_processed / max(1, expected_samples))
                fps_rate = samples_processed / elapsed if elapsed > 0 else 0
                eta_sec = int((expected_samples - samples_processed) / fps_rate) if fps_rate > 0 else 0

                bar_len = 30
                filled = int(bar_len * progress_ratio)
                bar = "█" * filled + "░" * (bar_len - filled)
                pct_str = f"{progress_ratio * 100:5.1f}%"
                active_count = sum(1 for v in active_events.values() if v is not None)

                sys.stdout.write(
                    f"\r[{bar}] {pct_str} | {samples_processed}/{expected_samples} frames "
                    f"[{int(elapsed)}s<{eta_sec}s, {fps_rate:.1f} it/s] | Active violations: {active_count}"
                )
                sys.stdout.flush()

        # Video ingestion loop
        effective_batch_size = max(1, clip_batch_size) if use_clip_model else 8

        while True:
            ret, frame = cap.read()
            if not ret:
                break

            if frame_idx % frame_step == 0:
                rgb_img = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                pil_img = Image.fromarray(rgb_img)

                batch_items.append({
                    "frame_idx": frame_idx,
                    "frame_bgr": frame.copy(),
                    "pil_img": pil_img,
                })

                if len(batch_items) >= effective_batch_size:
                    process_batch(batch_items)
                    batch_items.clear()

            frame_idx += 1

        # Process any remaining frames in the last partial batch
        if batch_items:
            process_batch(batch_items)
            batch_items.clear()

        sys.stdout.write("\n")
        sys.stdout.flush()

        for k in all_tracked_keys:
            if active_events.get(k) is not None:
                close_event(k)

        # 1. Merge adjacent splits of same category (raw category intervals)
        category_merged_timeline = merge_adjacent_events(raw_timeline, max_merge_gap_sec=bridge_gap_sec)

        # 2. Build Category-Wise Timeline mapping
        # Each category key contains its list of continuous intervals
        category_timeline: Dict[str, Dict[str, Any]] = {}
        for cat_key in all_tracked_keys:
            cat_display = CATEGORY_LABELS.get(cat_key, cat_key)
            intervals = [
                {
                    "start_time": ev["start_time"],
                    "end_time": ev["end_time"],
                    "duration_sec": format_seconds(ev["end_time"] - ev["start_time"]),
                    "peak_confidence": ev["peak_confidence"],
                }
                for ev in category_merged_timeline if ev["raw_label"] == cat_key
            ]
            if intervals:
                category_timeline[cat_key] = {
                    "category_name": cat_display,
                    "raw_label": cat_key,
                    "interval_count": len(intervals),
                    "intervals": intervals,
                }

        # 3. Merged overarching master scenes across overlapping categories for chapter embedding
        consolidated_timeline = merge_overlapping_intervals(raw_timeline, tolerance_sec=bridge_gap_sec)
        print(f"\n[Timeline Consolidation] Categorized {len(category_merged_timeline)} events into {len(category_timeline)} categories.")
        print(f"[Timeline Consolidation] Merged into {len(consolidated_timeline)} unified master scenes.")

        # Embed continuous chapters across entire video timeline
        if embed_chapters:
            target_video = Path(output_video_path) if output_video_path else video_path.with_name(f"{video_path.stem}_with_chapters.mp4")
            embed_video_chapters(
                input_video=video_path,
                output_video=target_video,
                timeline=consolidated_timeline,
                total_duration_sec=duration_sec,
            )

        # Export Category-Wise Timeline JSON (with master consolidated scenes metadata)
        if output_json_path:
            out_file = Path(output_json_path)
            out_file.parent.mkdir(parents=True, exist_ok=True)
            export_payload = {
                "video_metadata": {
                    "video_path": str(video_path),
                    "fps": round(video_fps, 2),
                    "total_frames": total_frames,
                    "duration_sec": format_seconds(duration_sec),
                },
                "categories": category_timeline,
                "unified_scenes": consolidated_timeline,
            }
            with open(out_file, "w", encoding="utf-8") as f:
                json.dump(export_payload, f, indent=2)
            print(f"[Timeline Data] Exported category-wise timeline into '{out_file}'!")

        # Save detailed raw CLIP model descriptions JSON if requested
        if output_clip_json_path and use_clip_model:
            clip_file = Path(output_clip_json_path)
            clip_file.parent.mkdir(parents=True, exist_ok=True)
            with open(clip_file, "w", encoding="utf-8") as f:
                json.dump(clip_logs, f, indent=2)
            print(f"[CLIP Log Data] Saved detailed CLIP model text descriptions into '{clip_file}'!")

        return consolidated_timeline

    finally:
        cap.release()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Overlapping Scene Moderation with Continuous Video Chapters and CLIP Frame Batching"
    )
    parser.add_argument("video_path", type=str, help="Path to input video file")
    parser.add_argument(
        "--fps-sample",
        type=float,
        default=1.0,
        help="Sampling rate in frames per second (default: 1.0)",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=16,
        help="Batch size of frames passed to CLIP encoder at once (e.g. 8, 16, 32; default: 16)",
    )
    # Model Selection Flags
    parser.add_argument(
        "--models",
        type=str,
        default="scene,nudenet,clip",
        help="Comma-separated list of models to execute: 'scene', 'nudenet', 'clip' or 'all' (default: all three)",
    )
    parser.add_argument(
        "--no-scene",
        action="store_true",
        help="Disable Falconsai NSFW scene classifier",
    )
    parser.add_argument(
        "--no-nudenet",
        action="store_true",
        help="Disable NudeNet anatomical body part detector",
    )
    parser.add_argument(
        "--no-clip",
        action="store_true",
        help="Disable OpenCLIP vision-language model",
    )
    parser.add_argument(
        "--bridge-gap",
        type=float,
        default=3.5,
        help="Gap tolerance in seconds to merge scenes (default: 3.5s)",
    )
    parser.add_argument(
        "--scene-conf",
        type=float,
        default=0.40,
        help="Confidence threshold for intimate/NSFW scenes (default: 0.40)",
    )
    parser.add_argument(
        "--part-conf",
        type=float,
        default=0.35,
        help="Confidence threshold for anatomical body parts (default: 0.35)",
    )
    parser.add_argument(
        "--clip-conf",
        type=float,
        default=0.60,
        help="Confidence threshold for CLIP romance/kissing (default: 0.60)",
    )
    parser.add_argument(
        "--output-video",
        type=str,
        default=None,
        help="Target video file with chapters (default: [name]_with_chapters.mp4)",
    )
    parser.add_argument(
        "--output",
        type=str,
        default="timeline.json",
        help="Output path for JSON timeline",
    )
    parser.add_argument(
        "--clip-output",
        type=str,
        default="clip_descriptions.json",
        help="Output path to export detailed raw CLIP text descriptions JSON (default: clip_descriptions.json)",
    )

    args = parser.parse_args()

    # Determine which models to run
    selected_models = set(m.strip().lower() for m in args.models.split(",") if m.strip())
    is_all = "all" in selected_models

    use_scene = (is_all or "scene" in selected_models) and not args.no_scene
    use_nudenet = (is_all or "nudenet" in selected_models) and not args.no_nudenet
    use_clip = (is_all or "clip" in selected_models) and not args.no_clip

    timeline = process_video_moderation_full(
        video_path=args.video_path,
        sample_rate_fps=args.fps_sample,
        scene_conf_threshold=args.scene_conf,
        part_conf_threshold=args.part_conf,
        clip_conf_threshold=args.clip_conf,
        bridge_gap_sec=args.bridge_gap,
        use_scene_model=use_scene,
        use_nudenet_model=use_nudenet,
        use_clip_model=use_clip,
        clip_batch_size=args.batch_size,
        output_video_path=args.output_video,
        output_json_path=args.output,
        output_clip_json_path=args.clip_output,
    )

    print("\n--- Consolidated Moderation Timeline ---")
    print(json.dumps(timeline, indent=2))
