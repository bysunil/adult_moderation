/**
 * Smart Content Moderation Player Engine
 *
 * Handles:
 * 1. Synchronized playback tracking with frame-accurate auto-skip state machine.
 * 2. Visual color-coded timeline segments overlay with hover scrub previews.
 * 3. User toggle preferences with persistent localStorage storage.
 * 4. Custom file uploads (local video and JSON timeline files).
 */

// Category definition registry with associated color tokens and display names
const CATEGORY_REGISTRY = {
  "FEMALE_GENITALIA_EXPOSED": { name: "Exposed Genitalia", color: "#ef4444", classKey: "nudity", defaultSkip: true },
  "MALE_GENITALIA_EXPOSED": { name: "Exposed Genitalia", color: "#ef4444", classKey: "nudity", defaultSkip: true },
  "FEMALE_BREAST_EXPOSED": { name: "Exposed Breast / Nipple", color: "#f43f5e", classKey: "nudity", defaultSkip: true },
  "BUTTOCKS_EXPOSED": { name: "Exposed Buttocks", color: "#fb7185", classKey: "nudity", defaultSkip: true },
  "INTIMATE_SCENE": { name: "Intimate / NSFW Scene", color: "#ec4899", classKey: "intimate", defaultSkip: true },
  "ROMANCE_KISS": { name: "Kissing / Romantic Intimacy", color: "#a855f7", classKey: "kiss", defaultSkip: true },
  "VIOLENCE": { name: "Physical Violence / Fight", color: "#ea580c", classKey: "violence", defaultSkip: true },
  "GUNFIRE_EXPLOSION": { name: "Gunfire / Explosions", color: "#f59e0b", classKey: "gunfire", defaultSkip: true },
  "BLOOD_GORE": { name: "Blood / Gore / Injury", color: "#b91c1c", classKey: "violence", defaultSkip: true },
  "SMOKING": { name: "Cigarette / Tobacco Smoking", color: "#64748b", classKey: "smoking", defaultSkip: false },
  "ALCOHOL": { name: "Alcohol Consumption", color: "#06b6d4", classKey: "alcohol", defaultSkip: false },
  "BELLY_EXPOSED": { name: "Bareback / Exposed Midriff", color: "#14b8a6", classKey: "belly", defaultSkip: false },
  "ARMPITS_EXPOSED": { name: "Exposed Skin / Armpits", color: "#10b981", classKey: "belly", defaultSkip: false },
};

// Application State
const appState = {
  timeline: [],
  masterAutoSkip: true,
  categoryFilters: {},
  notificationTimer: null,
  isScrubbing: false,
};

// DOM References
const videoEl = document.getElementById("main-video-element");
const timelineTrack = document.getElementById("timeline-track");
const segmentLayer = document.getElementById("timeline-segment-layer");
const playheadFill = document.getElementById("timeline-playhead-fill");
const scrubberHandle = document.getElementById("timeline-scrubber-handle");
const timeDisplay = document.getElementById("playback-time-display");
const contentBadge = document.getElementById("current-content-badge");
const contentStatusLabel = document.getElementById("current-status-label");
const skipNotification = document.getElementById("skip-notification");
const skipNotificationText = document.getElementById("skip-notification-text");
const masterSwitch = document.getElementById("master-skip-switch");
const categoryContainer = document.getElementById("category-toggles-container");
const intervalsListContainer = document.getElementById("intervals-list-container");
const videoFileInput = document.getElementById("local-video-file-input");
const jsonFileInput = document.getElementById("local-json-file-input");

// Format seconds into MM:SS
function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return "00:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

// Initialize Preferences from localStorage or defaults
function initPreferences() {
  const savedMaster = localStorage.getItem("sentinel_master_skip");
  appState.masterAutoSkip = savedMaster !== null ? savedMaster === "true" : true;
  masterSwitch.checked = appState.masterAutoSkip;

  const savedFilters = localStorage.getItem("sentinel_cat_filters");
  if (savedFilters) {
    try {
      appState.categoryFilters = JSON.parse(savedFilters);
    } catch (e) {
      appState.categoryFilters = {};
    }
  }

  // Populate default filter states if missing
  for (const [key, config] of Object.entries(CATEGORY_REGISTRY)) {
    if (appState.categoryFilters[key] === undefined) {
      appState.categoryFilters[key] = config.defaultSkip;
    }
  }

  renderCategoryToggles();
}

// Render Settings Category Toggles
function renderCategoryToggles() {
  categoryContainer.innerHTML = "";

  for (const [key, config] of Object.entries(CATEGORY_REGISTRY)) {
    const isChecked = !!appState.categoryFilters[key];

    const item = document.createElement("div");
    item.className = "category-filter-item";
    item.innerHTML = `
      <div class="category-meta">
        <span class="category-color-dot" style="background-color: ${config.color};"></span>
        <span class="category-name-text">${config.name}</span>
      </div>
      <label class="switch">
        <input type="checkbox" data-cat="${key}" ${isChecked ? "checked" : ""}>
        <span class="slider"></span>
      </label>
    `;

    const checkbox = item.querySelector("input");
    checkbox.addEventListener("change", (e) => {
      appState.categoryFilters[key] = e.target.checked;
      localStorage.setItem("sentinel_cat_filters", JSON.stringify(appState.categoryFilters));
      renderTimelineSegments();
      checkCurrentPlaybackState(videoEl.currentTime);
    });

    categoryContainer.appendChild(item);
  }
}

// Load Timeline Data (from API or local file)
async function loadTimelineData() {
  try {
    const res = await fetch("/api/timeline");
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        setTimeline(data);
        return;
      }
    }
  } catch (err) {
    console.warn("Could not load /api/timeline from server:", err);
  }

  // If server fetch failed, initialize with empty array
  setTimeline([]);
}

function setTimeline(data) {
  appState.timeline = Array.isArray(data) ? data : [];
  document.getElementById("total-scenes-counter").textContent = `${appState.timeline.length} Scenes`;
  renderTimelineSegments();
  renderIntervalsList();
}

// Render Color Coded Segments on the Progress Track
function renderTimelineSegments() {
  segmentLayer.innerHTML = "";
  const duration = videoEl.duration;
  if (!duration || duration <= 0) return;

  appState.timeline.forEach((scene) => {
    const start = scene.start_time;
    const end = scene.end_time;
    const leftPct = (start / duration) * 100;
    const widthPct = Math.max(0.5, ((end - start) / duration) * 100);

    const seg = document.createElement("div");
    seg.className = "timeline-segment";

    const reg = CATEGORY_REGISTRY[scene.raw_label];
    const classKey = reg ? reg.classKey : "nudity";
    seg.classList.add(classKey);

    const isFiltered = appState.masterAutoSkip && appState.categoryFilters[scene.raw_label];
    seg.style.left = `${leftPct}%`;
    seg.style.width = `${widthPct}%`;
    seg.style.opacity = isFiltered ? "0.95" : "0.35";
    seg.title = `${scene.content_type} (${formatTime(start)} - ${formatTime(end)}) - Auto-Skip: ${isFiltered ? "ON" : "OFF"}`;

    segmentLayer.appendChild(seg);
  });
}

// Render Detected Scenes in the Sidebar List
function renderIntervalsList() {
  intervalsListContainer.innerHTML = "";

  if (appState.timeline.length === 0) {
    intervalsListContainer.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 24px 0; font-size: 13px;">
        No moderation events loaded.<br>Use 'Load Timeline JSON' or run adult_moderation.py.
      </div>
    `;
    return;
  }

  appState.timeline.forEach((item, idx) => {
    const row = document.createElement("div");
    row.className = "interval-row-item";
    row.id = `interval-row-${idx}`;

    const reg = CATEGORY_REGISTRY[item.raw_label] || { color: "#ef4444" };
    const confPct = Math.round((item.peak_confidence || 0) * 100);

    let subText = "";
    if (item.sub_events && item.sub_events.length > 0) {
      subText = ` · ${item.sub_events.length} sub-events`;
    }

    row.innerHTML = `
      <div class="interval-left">
        <div style="display: flex; align-items: center; gap: 6px;">
          <span style="width: 8px; height: 8px; border-radius: 50%; background: ${reg.color};"></span>
          <span class="interval-title">${item.content_type}</span>
        </div>
        <span class="interval-timestamp">${formatTime(item.start_time)} → ${formatTime(item.end_time)}${subText}</span>
      </div>
      <div class="interval-right">
        <span class="confidence-tag">${confPct}%</span>
        <button class="action-jump-btn" title="Seek to scene">Seek</button>
      </div>
    `;

    row.addEventListener("click", () => {
      videoEl.currentTime = Math.max(0, item.start_time - 0.5);
      videoEl.play();
    });

    intervalsListContainer.appendChild(row);
  });
}

// Show Non-Intrusive Skip Toast
function showSkipNotification(message) {
  skipNotificationText.textContent = message;
  skipNotification.classList.add("active");

  if (appState.notificationTimer) {
    clearTimeout(appState.notificationTimer);
  }

  appState.notificationTimer = setTimeout(() => {
    skipNotification.classList.remove("active");
  }, 2400);
}

// Core Skip State Machine Loop
function checkCurrentPlaybackState(currentTime) {
  let activeScene = null;

  for (let i = 0; i < appState.timeline.length; i++) {
    const scene = appState.timeline[i];
    // Check if within bounds of scene interval
    if (currentTime >= scene.start_time && currentTime < scene.end_time) {
      activeScene = scene;
      highlightActiveIntervalRow(i);

      // Check if auto-skip rule applies to this category
      const isEligibleForSkip = appState.masterAutoSkip && appState.categoryFilters[scene.raw_label];
      if (isEligibleForSkip) {
        // Fast-forward seek directly to the end of the flagged scene
        const targetTime = scene.end_time + 0.1;
        videoEl.currentTime = targetTime;
        showSkipNotification(`Skipped ${scene.content_type} (${formatTime(scene.start_time)} → ${formatTime(scene.end_time)})`);
        return;
      }
      break;
    }
  }

  // Update Status Tag in UI
  if (activeScene) {
    contentBadge.className = "current-status-tag flagged";
    contentStatusLabel.textContent = activeScene.content_type;
  } else {
    contentBadge.className = "current-status-tag";
    contentStatusLabel.textContent = "Normal Content";
    clearActiveIntervalRows();
  }
}

function highlightActiveIntervalRow(index) {
  clearActiveIntervalRows();
  const el = document.getElementById(`interval-row-${index}`);
  if (el) {
    el.classList.add("active-now");
  }
}

function clearActiveIntervalRows() {
  document.querySelectorAll(".interval-row-item.active-now").forEach((el) => {
    el.classList.remove("active-now");
  });
}

// Video Time Update Event Listener
videoEl.addEventListener("timeupdate", () => {
  if (appState.isScrubbing) return;

  const current = videoEl.currentTime;
  const duration = videoEl.duration || 1;

  // Update time display
  timeDisplay.textContent = `${formatTime(current)} / ${formatTime(duration)}`;

  // Update playhead position on custom track
  const pct = (current / duration) * 100;
  playheadFill.style.width = `${pct}%`;
  scrubberHandle.style.left = `${pct}%`;

  // Evaluate Auto-Skip
  checkCurrentPlaybackState(current);
});

videoEl.addEventListener("loadedmetadata", () => {
  renderTimelineSegments();
  timeDisplay.textContent = `${formatTime(videoEl.currentTime)} / ${formatTime(videoEl.duration)}`;
});

// Interactive Timeline Track Scrubbing
function handleTrackSeek(e) {
  const rect = timelineTrack.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const ratio = Math.max(0, Math.min(1, clickX / rect.width));
  const newTime = ratio * videoEl.duration;
  videoEl.currentTime = newTime;
}

timelineTrack.addEventListener("click", handleTrackSeek);

// Master Auto-Skip Toggle
masterSwitch.addEventListener("change", (e) => {
  appState.masterAutoSkip = e.target.checked;
  localStorage.setItem("sentinel_master_skip", appState.masterAutoSkip.toString());
  renderTimelineSegments();
  checkCurrentPlaybackState(videoEl.currentTime);
});

// User Custom Local Video File Input
videoFileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) {
    const objectUrl = URL.createObjectURL(file);
    videoEl.src = objectUrl;
    videoEl.play();
  }
});

// User Custom JSON File Input
jsonFileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target.result);
        setTimeline(parsed);
      } catch (err) {
        alert("Invalid JSON timeline file: " + err.message);
      }
    };
    reader.readAsText(file);
  }
});

// Initial Setup
initPreferences();
loadTimelineData();
