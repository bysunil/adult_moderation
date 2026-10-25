'use client';

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  Sliders,
  ShieldCheck,
  ShieldAlert,
  FastForward,
  FolderOpen,
  FileCode,
  Sparkles,
  Info,
  CheckCircle2,
  Layers,
  Flame,
  Wine,
  Cigarette,
  Crosshair,
  Heart,
  EyeOff,
  Skull
} from 'lucide-react';

// Category Configuration Registry
const CATEGORY_REGISTRY = {
  FEMALE_GENITALIA_EXPOSED: { name: 'Exposed Genitalia', color: '#ef4444', icon: EyeOff, defaultSkip: true, group: 'Adult Content' },
  MALE_GENITALIA_EXPOSED: { name: 'Exposed Genitalia', color: '#ef4444', icon: EyeOff, defaultSkip: true, group: 'Adult Content' },
  FEMALE_BREAST_EXPOSED: { name: 'Exposed Breast / Nipple', color: '#f43f5e', icon: EyeOff, defaultSkip: true, group: 'Adult Content' },
  BUTTOCKS_EXPOSED: { name: 'Exposed Buttocks', color: '#fb7185', icon: EyeOff, defaultSkip: true, group: 'Adult Content' },
  INTIMATE_SCENE: { name: 'Intimate / NSFW Scene', color: '#ec4899', icon: Flame, defaultSkip: true, group: 'Intimacy' },
  ROMANCE_KISS: { name: 'Kissing / Romance', color: '#a855f7', icon: Heart, defaultSkip: true, group: 'Intimacy' },
  VIOLENCE: { name: 'Violence / Fighting', color: '#ea580c', icon: Skull, defaultSkip: true, group: 'Violence & Action' },
  GUNFIRE_EXPLOSION: { name: 'Gunfire / Explosions', color: '#f59e0b', icon: Crosshair, defaultSkip: true, group: 'Violence & Action' },
  BLOOD_GORE: { name: 'Blood & Gore', color: '#b91c1c', icon: Skull, defaultSkip: true, group: 'Violence & Action' },
  SMOKING: { name: 'Tobacco Smoking', color: '#64748b', icon: Cigarette, defaultSkip: false, group: 'Substances' },
  ALCOHOL: { name: 'Alcohol Consumption', color: '#06b6d4', icon: Wine, defaultSkip: false, group: 'Substances' },
  BELLY_EXPOSED: { name: 'Bareback / Midriff', color: '#14b8a6', icon: EyeOff, defaultSkip: false, group: 'Adult Content' },
};

function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export default function SmartOTTPlayer() {
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const controlsTimeoutRef = useRef(null);

  // Playback States
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);

  // Raw & Dynamic Data
  const [rawCategories, setRawCategories] = useState({});
  const [videoSrc, setVideoSrc] = useState('/api/stream?file=ANIMAL_with_chapters.mp4');
  const [videoTitle, setVideoTitle] = useState('ANIMAL_with_chapters.mp4');

  // Filter & Skip Preferences
  const [masterAutoSkip, setMasterAutoSkip] = useState(true);
  const [categoryFilters, setCategoryFilters] = useState({});
  const [showSettingsDrawer, setShowSettingsDrawer] = useState(false);

  // Notifications
  const [skipToast, setSkipToast] = useState(null);
  const [activeScene, setActiveScene] = useState(null);

  // Initialize Preferences & Load Timeline
  useEffect(() => {
    const savedMaster = localStorage.getItem('ott_master_skip');
    if (savedMaster !== null) setMasterAutoSkip(savedMaster === 'true');

    const savedFilters = localStorage.getItem('ott_category_filters');
    let initialFilters = {};
    if (savedFilters) {
      try {
        initialFilters = JSON.parse(savedFilters);
      } catch (e) {
        initialFilters = {};
      }
    }
    for (const [key, cfg] of Object.entries(CATEGORY_REGISTRY)) {
      if (initialFilters[key] === undefined) {
        initialFilters[key] = cfg.defaultSkip;
      }
    }
    setCategoryFilters(initialFilters);

    // Fetch initial timeline
    fetch('/api/timeline')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && data.categories) {
          setRawCategories(data.categories);
        }
      })
      .catch((err) => console.warn('Could not load timeline API:', err));
  }, []);

  // Update localStorage when filters change
  const handleToggleCategory = (catKey) => {
    const updated = { ...categoryFilters, [catKey]: !categoryFilters[catKey] };
    setCategoryFilters(updated);
    localStorage.setItem('ott_category_filters', JSON.stringify(updated));
  };

  const handleToggleMasterSkip = () => {
    const updated = !masterAutoSkip;
    setMasterAutoSkip(updated);
    localStorage.setItem('ott_master_skip', updated.toString());
  };

  // Dynamic Category-Wise Interval Merging Engine
  const mergedActiveTimeline = useMemo(() => {
    const activeEvents = [];

    for (const [catKey, isEnabled] of Object.entries(categoryFilters)) {
      if (!isEnabled) continue;
      const catObj = rawCategories[catKey];
      if (!catObj) continue;

      const intervals = catObj.intervals || [];
      const reg = CATEGORY_REGISTRY[catKey];
      const displayName = reg ? reg.name : catObj.category_name || catKey;

      intervals.forEach((iv) => {
        activeEvents.push({
          raw_label: catKey,
          content_type: displayName,
          start_time: iv.start_time,
          end_time: iv.end_time,
          peak_confidence: iv.peak_confidence || 0.8,
        });
      });
    }

    if (activeEvents.length === 0) return [];

    // Sort by start time
    activeEvents.sort((a, b) => a.start_time - b.start_time);

    // Merge overlapping intervals within 3.0s bridge window
    const bridgeGapSec = 3.0;
    const merged = [];
    let current = {
      start_time: activeEvents[0].start_time,
      end_time: activeEvents[0].end_time,
      peak_confidence: activeEvents[0].peak_confidence,
      content_types: [activeEvents[0].content_type],
      categories: [activeEvents[0].raw_label],
      sub_events: [activeEvents[0]],
    };

    for (let i = 1; i < activeEvents.length; i++) {
      const next = activeEvents[i];
      if (next.start_time <= current.end_time + bridgeGapSec) {
        current.end_time = Math.max(current.end_time, next.end_time);
        current.peak_confidence = Math.max(current.peak_confidence, next.peak_confidence);
        if (!current.content_types.includes(next.content_type)) {
          current.content_types.push(next.content_type);
        }
        if (!current.categories.includes(next.raw_label)) {
          current.categories.push(next.raw_label);
        }
        current.sub_events.push(next);
      } else {
        merged.push({
          ...current,
          display_title: current.content_types.join(' + '),
          duration: +(current.end_time - current.start_time).toFixed(2),
        });
        current = {
          start_time: next.start_time,
          end_time: next.end_time,
          peak_confidence: next.peak_confidence,
          content_types: [next.content_type],
          categories: [next.raw_label],
          sub_events: [next],
        };
      }
    }

    merged.push({
      ...current,
      display_title: current.content_types.join(' + '),
      duration: +(current.end_time - current.start_time).toFixed(2),
    });

    return merged;
  }, [categoryFilters, rawCategories]);

  // Video Time Update & Real-Time Auto-Skip Guard
  const handleTimeUpdate = useCallback(() => {
    if (!videoRef.current) return;
    const t = videoRef.current.currentTime;
    setCurrentTime(t);

    // Check if within bounds of any merged active violation
    let found = null;
    for (const scene of mergedActiveTimeline) {
      if (t >= scene.start_time && t < scene.end_time) {
        found = scene;
        if (masterAutoSkip) {
          // Frame-accurate auto-skip forward past the violation
          const skipTo = scene.end_time + 0.15;
          videoRef.current.currentTime = skipTo;
          setSkipToast({
            title: `Skipped ${scene.display_title}`,
            range: `${formatTime(scene.start_time)} → ${formatTime(scene.end_time)}`,
          });
          setTimeout(() => setSkipToast(null), 3200);
          return;
        }
        break;
      }
    }
    setActiveScene(found);
  }, [mergedActiveTimeline, masterAutoSkip]);

  // Play / Pause Toggle
  const togglePlay = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play();
      setIsPlaying(true);
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  };

  // Skip 5 Seconds Forward / Backward
  const skipSeconds = (delta) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = Math.max(0, Math.min(duration, videoRef.current.currentTime + delta));
  };

  // Fullscreen Toggle
  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch((err) => console.error(err));
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  // Auto-hide controls when mouse is inactive
  const handleMouseMove = () => {
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying) setShowControls(false);
    }, 3200);
  };

  // Keyboard Shortcuts (Space: Play/Pause, Left: -5s, Right: +5s, F: Fullscreen, M: Mute)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        skipSeconds(-5);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        skipSeconds(5);
      } else if (e.key === 'f' || e.key === 'F') {
        toggleFullscreen();
      } else if (e.key === 'm' || e.key === 'M') {
        setIsMuted((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, duration]);

  // Custom Local Video File Selection
  const handleOpenLocalVideo = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setVideoSrc(url);
      setVideoTitle(file.name);
      setIsPlaying(false);
    }
  };

  // Custom Local JSON Timeline File Selection
  const handleOpenLocalJSON = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const parsed = JSON.parse(event.target.result);
          if (parsed.categories) {
            setRawCategories(parsed.categories);
          } else if (Array.isArray(parsed)) {
            // Convert flat array to category-wise map
            const converted = {};
            parsed.forEach((item) => {
              const k = item.raw_label || 'INTIMATE_SCENE';
              if (!converted[k]) converted[k] = { intervals: [] };
              converted[k].intervals.push({
                start_time: item.start_time,
                end_time: item.end_time,
                peak_confidence: item.peak_confidence,
              });
            });
            setRawCategories(converted);
          }
        } catch (err) {
          alert('Invalid JSON file: ' + err.message);
        }
      };
      reader.readAsText(file);
    }
  };

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      suppressHydrationWarning
      className="relative flex flex-col w-screen h-screen overflow-hidden bg-[#07090e] text-slate-100 select-none"
    >
      {/* Top OTT Header Overlay */}
      <header
        className={`absolute top-0 left-0 right-0 z-30 flex items-center justify-between px-6 py-4 bg-gradient-to-b from-black/85 via-black/40 to-transparent transition-opacity duration-300 ${
          showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-1 text-xs font-black tracking-widest text-white uppercase rounded bg-gradient-to-r from-red-600 to-rose-500 shadow-lg shadow-red-600/30">
              OTT GUARD
            </span>
            <span className="text-sm font-semibold tracking-wide text-slate-200 truncate max-w-[280px] md:max-w-md">
              {videoTitle}
            </span>
          </div>

          {/* Current Content Safety Status Badge */}
          {activeScene ? (
            <span className="flex items-center gap-1.5 px-3 py-1 text-xs font-bold text-red-300 rounded-full bg-red-950/70 border border-red-500/40 animate-pulse">
              <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
              {activeScene.display_title}
            </span>
          ) : (
            <span className="flex items-center gap-1.5 px-3 py-1 text-xs font-semibold text-emerald-300 rounded-full bg-emerald-950/60 border border-emerald-500/30">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              Safe Content
            </span>
          )}
        </div>

        {/* Top Right Action Tools */}
        <div className="flex items-center gap-3">
          {/* Open Video File */}
          <label className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium transition rounded-lg cursor-pointer bg-white/10 hover:bg-white/20 border border-white/10 text-slate-200">
            <FolderOpen className="w-4 h-4 text-cyan-400" />
            <span className="hidden sm:inline">Open Video</span>
            <input type="file" accept="video/mp4,video/webm" className="hidden" onChange={handleOpenLocalVideo} />
          </label>

          {/* Load JSON Timeline */}
          <label className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium transition rounded-lg cursor-pointer bg-white/10 hover:bg-white/20 border border-white/10 text-slate-200">
            <FileCode className="w-4 h-4 text-purple-400" />
            <span className="hidden sm:inline">Load Timeline</span>
            <input type="file" accept="application/json" className="hidden" onChange={handleOpenLocalJSON} />
          </label>

          {/* Preferences Button */}
          <button
            onClick={() => setShowSettingsDrawer(!showSettingsDrawer)}
            className={`flex items-center gap-2 px-3.5 py-1.5 text-xs font-semibold transition rounded-lg border ${
              showSettingsDrawer
                ? 'bg-blue-600 border-blue-500 text-white shadow-lg shadow-blue-600/40'
                : 'bg-white/10 border-white/15 text-slate-200 hover:bg-white/20'
            }`}
          >
            <Sliders className="w-4 h-4" />
            <span>Skip Rules</span>
          </button>
        </div>
      </header>

      {/* Main Video Viewport */}
      <div className="relative flex items-center justify-center flex-1 w-full h-full bg-black">
        <video
          ref={videoRef}
          src={videoSrc}
          onClick={togglePlay}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={() => setDuration(videoRef.current?.duration || 0)}
          onEnded={() => setIsPlaying(false)}
          className="object-contain w-full h-full"
          playsInline
        />

        {/* Skip Toast Notification */}
        {skipToast && (
          <div className="absolute top-24 z-40 flex items-center gap-3 px-5 py-2.5 rounded-xl bg-slate-900/90 backdrop-blur-xl border border-red-500/40 text-white shadow-2xl shadow-red-950/60 animate-bounce">
            <FastForward className="w-5 h-5 text-red-400" />
            <div>
              <div className="text-xs font-bold text-red-400 uppercase tracking-wider">Auto-Skipped Scene</div>
              <div className="text-sm font-semibold">{skipToast.title} <span className="text-slate-400 text-xs">({skipToast.range})</span></div>
            </div>
          </div>
        )}
      </div>

      {/* Modern OTT Bottom Controls Overlay */}
      <div
        className={`absolute bottom-0 left-0 right-0 z-30 px-6 pb-6 pt-16 bg-gradient-to-t from-black/95 via-black/60 to-transparent transition-opacity duration-300 ${
          showControls || !isPlaying ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Interactive Scrub Timeline Bar with Highlighted Category Segments */}
        <div className="relative w-full mb-4">
          <div
            onClick={(e) => {
              if (!duration || !videoRef.current) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
              videoRef.current.currentTime = ratio * duration;
            }}
            className="relative h-2.5 group hover:h-4 w-full bg-white/15 rounded-full cursor-pointer transition-all duration-150 overflow-hidden"
          >
            {/* Color-Coded Moderation Scene Segments */}
            {mergedActiveTimeline.map((scene, i) => {
              if (!duration) return null;
              const left = (scene.start_time / duration) * 100;
              const width = Math.max(0.6, ((scene.end_time - scene.start_time) / duration) * 100);
              const color = CATEGORY_REGISTRY[scene.categories[0]]?.color || '#ef4444';

              return (
                <div
                  key={i}
                  style={{ left: `${left}%`, width: `${width}%`, backgroundColor: color }}
                  title={`${scene.display_title} (${formatTime(scene.start_time)} - ${formatTime(scene.end_time)})`}
                  className="absolute top-0 bottom-0 opacity-80 group-hover:opacity-100 transition-opacity"
                />
              );
            })}

            {/* Playhead Progress Fill */}
            <div
              style={{ width: `${(currentTime / (duration || 1)) * 100}%` }}
              className="absolute top-0 bottom-0 left-0 bg-white/40 pointer-events-none rounded-full"
            />
          </div>

          {/* Current Progress Knob */}
          <div
            style={{ left: `${(currentTime / (duration || 1)) * 100}%` }}
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 bg-white rounded-full shadow-lg shadow-black/80 pointer-events-none transition-all"
          />
        </div>

        {/* Lower Control Bar: Buttons & Sliders */}
        <div className="flex items-center justify-between">
          {/* Left: Play, Skip 5s, Volume, Time */}
          <div className="flex items-center gap-4">
            {/* Play / Pause */}
            <button
              onClick={togglePlay}
              className="p-2.5 transition rounded-full bg-white/10 hover:bg-white/20 text-white hover:scale-105 active:scale-95"
            >
              {isPlaying ? <Pause className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current ml-0.5" />}
            </button>

            {/* Skip 5s Backward */}
            <button
              onClick={() => skipSeconds(-5)}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold transition rounded-lg bg-white/10 hover:bg-white/20 text-slate-200"
              title="Skip -5s (Left Arrow)"
            >
              <RotateCcw className="w-4 h-4" />
              <span>5s</span>
            </button>

            {/* Skip 5s Forward */}
            <button
              onClick={() => skipSeconds(5)}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold transition rounded-lg bg-white/10 hover:bg-white/20 text-slate-200"
              title="Skip +5s (Right Arrow)"
            >
              <RotateCw className="w-4 h-4" />
              <span>5s</span>
            </button>

            {/* Volume Control */}
            <div className="flex items-center gap-2 group">
              <button
                onClick={() => {
                  if (!videoRef.current) return;
                  videoRef.current.muted = !isMuted;
                  setIsMuted(!isMuted);
                }}
                className="p-2 text-slate-300 hover:text-white"
              >
                {isMuted || volume === 0 ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={isMuted ? 0 : volume}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  setVolume(v);
                  if (videoRef.current) {
                    videoRef.current.volume = v;
                    videoRef.current.muted = v === 0;
                  }
                  setIsMuted(v === 0);
                }}
                className="w-16 h-1 accent-white bg-white/20 rounded cursor-pointer transition-all"
              />
            </div>

            {/* Time Indicator */}
            <div className="text-xs font-medium text-slate-400">
              <span className="text-slate-100 font-semibold">{formatTime(currentTime)}</span> / {formatTime(duration)}
            </div>
          </div>

          {/* Right: Detected Scenes Count, Fullscreen */}
          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-2 text-xs font-medium text-slate-400 bg-white/5 px-3 py-1.5 rounded-lg border border-white/10">
              <Layers className="w-4 h-4 text-slate-400" />
              <span>{mergedActiveTimeline.length} Filtered Scenes</span>
            </div>

            <button
              onClick={toggleFullscreen}
              className="p-2.5 transition rounded-lg bg-white/10 hover:bg-white/20 text-white"
            >
              {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Floating OTT Settings & Skip Preferences Drawer */}
      {showSettingsDrawer && (
        <div className="absolute top-18 right-6 z-40 w-96 max-h-[85vh] flex flex-col rounded-2xl glass-dropdown overflow-hidden shadow-2xl border border-white/15 animate-in fade-in slide-in-from-top-4 duration-200">
          {/* Drawer Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 bg-white/5">
            <div className="flex items-center gap-2">
              <Sliders className="w-4 h-4 text-blue-400" />
              <h3 className="text-sm font-bold tracking-wide text-white">Auto-Skip Rules & Filters</h3>
            </div>
            <button
              onClick={() => setShowSettingsDrawer(false)}
              className="text-xs font-semibold text-slate-400 hover:text-white"
            >
              Close
            </button>
          </div>

          {/* Master Toggle */}
          <div className="p-4 border-b border-white/10 bg-blue-950/20">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-bold text-blue-200">Master Auto-Skip</div>
                <div className="text-xs text-slate-400 mt-0.5">Automatically jump past selected content</div>
              </div>
              <button
                onClick={handleToggleMasterSkip}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  masterAutoSkip ? 'bg-blue-600' : 'bg-slate-700'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    masterAutoSkip ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </div>

          {/* Granular Category Toggles */}
          <div className="flex-1 p-4 overflow-y-auto space-y-2">
            <div className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Content Categories</div>

            {Object.entries(CATEGORY_REGISTRY).map(([catKey, config]) => {
              const isChecked = !!categoryFilters[catKey];
              const catData = rawCategories[catKey];
              const count = catData ? catData.intervals?.length || 0 : 0;
              const Icon = config.icon;

              return (
                <div
                  key={catKey}
                  className="flex items-center justify-between p-2.5 rounded-xl bg-white/5 hover:bg-white/10 transition border border-white/5"
                >
                  <div className="flex items-center gap-3">
                    <div
                      style={{ backgroundColor: `${config.color}25`, color: config.color }}
                      className="p-1.5 rounded-lg border border-current/30"
                    >
                      <Icon className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-slate-200">{config.name}</div>
                      <div className="text-[10px] text-slate-400">
                        {count} detected in timeline
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={() => handleToggleCategory(catKey)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                      isChecked ? 'bg-blue-600' : 'bg-slate-700'
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                        isChecked ? 'translate-x-4.5' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              );
            })}
          </div>

          {/* Bottom Summary Bar */}
          <div className="p-4 border-t border-white/10 bg-black/40 flex items-center justify-between text-xs text-slate-400">
            <span>Intervals dynamically merged</span>
            <span className="font-bold text-slate-200">{mergedActiveTimeline.length} Active Skip Blocks</span>
          </div>
        </div>
      )}
    </div>
  );
}
