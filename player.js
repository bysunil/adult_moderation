/**
 * Smart Content Moderation Player Engine
 *
 * Supports:
 * 1. Category-wise storage: Video segments falling under multiple categories are maintained in each category.
 * 2. Dynamic Client-Side Interval Merging: Merging is re-computed on the fly based on which
 *    category toggles are enabled in the UI settings.
 * 3. Frame-accurate Auto-Skip & Chapter Seekbar highlights.
 */

// Category definition registry with associated colors and display titles
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
};

// Application State
const appState = {
  rawCategoryData: {},         // Raw intervals grouped category-wise { [cat_key]: [intervals...] }
  mergedActiveTimeline: [],     // Dynamically merged intervals based on currently active toggles
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

// Format seconds to MM:SS
function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return "00:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

// Initialize Preferences from localStorage
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

  for (const [key, config] of Object.entries(CATEGORY_REGISTRY)) {
    if (appState.categoryFilters[key] === undefined) {
      appState.categoryFilters[key] = config.defaultSkip;
    }
  }

  renderCategoryToggles();
}

// Render Category Toggles in UI Settings Drawer
function renderCategoryToggles() {
  categoryContainer.innerHTML = "";

  for (const [key, config] of Object.entries(CATEGORY_REGISTRY)) {
    const isChecked = !!appState.categoryFilters[key];
    const catData = appState.rawCategoryData[key];
    const count = catData ? (catData.intervals ? catData.intervals.length : catData.length) : 0;

    const item = document.createElement("div");
    item.className = "category-filter-item";
    item.innerHTML = `
      <div class="category-meta">
        <span class="category-color-dot" style="background-color: ${config.color};"></span>
        <div>
          <span class="category-name-text">${config.name}</span>
          ${count > 0 ? `<span style="font-size: 11px; color: var(--text-muted); margin-left: 6px;">(${count})</span>` : ""}
        </div>
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
      
      // Re-merge intervals dynamically based on new preferences
      recomputeDynamicMerging();
    });

    categoryContainer.appendChild(item);
  }
}

/**
 * Dynamic Interval Merging Engine
 *
 * Gathers all active intervals across categories chosen by the user and merges
 * overlapping or adjacent intervals (gap <= 3.0s) into unified scenes.
 */
function recomputeDynamicMerging(bridgeGapSec = 3.0) {
  const activeEvents = [];

  for (const [catKey, isEnabled] of Object.entries(appState.categoryFilters)) {
    if (!isEnabled) continue;

    const catObj = appState.rawCategoryData[catKey];
    if (!catObj) continue;

    const intervalList = catObj.intervals || catObj;
    const catDisplayName = CATEGORY_REGISTRY[catKey] ? CATEGORY_REGISTRY[catKey].name : (catObj.category_name || catKey);

    intervalList.forEach((iv) => {
      activeEvents.push({
        raw_label: catKey,
        content_type: catDisplayName,
        start_time: iv.start_time,
        end_time: iv.end_time,
        peak_confidence: iv.peak_confidence || 0.8,
      });
    });
  }

  if (activeEvents.length === 0) {
    appState.mergedActiveTimeline = [];
    renderTimelineSegments();
    renderIntervalsList();
    checkCurrentPlaybackState(videoEl.currentTime);
    return;
  }

  // Sort events by start time
  activeEvents.sort((a, b) => a.start_time - b.start_time);

  // Merge overlapping or contiguous events
  const mergedScenes = [];
  let current = {
    start_time: activeEvents[0].start_time,
    end_time: activeEvents[0].end_time,
    peak_confidence: activeEvents[0].peak_confidence,
    content_types: [activeEvents[0].content_type],
    categories: [activeEvents[0].raw_label],
    constituent_events: [activeEvents[0]],
  };

  for (let i = 1; i < activeEvents.length; i++) {
    const nextEv = activeEvents[i];

    // Check overlap or proximity within bridgeGapSec
    if (nextEv.start_time <= (current.end_time + bridgeGapSec)) {
      current.end_time = Math.max(current.end_time, nextEv.end_time);
      current.peak_confidence = Math.max(current.peak_confidence, nextEv.peak_confidence);
      if (!current.content_types.includes(nextEv.content_type)) {
        current.content_types.push(nextEv.content_type);
      }
      if (!current.categories.includes(nextEv.raw_label)) {
        current.categories.push(nextEv.raw_label);
      }
      current.constituent_events.push(nextEv);
    } else {
      mergedScenes.push(finalizeMergedScene(current));
      current = {
        start_time: nextEv.start_time,
        end_time: nextEv.end_time,
        peak_confidence: nextEv.peak_confidence,
        content_types: [nextEv.content_type],
        categories: [nextEv.raw_label],
        constituent_events: [nextEv],
      };
    }
  }

  mergedScenes.push(finalizeMergedScene(current));
  appState.mergedActiveTimeline = mergedScenes;

  renderTimelineSegments();
  renderIntervalsList();
  checkCurrentPlaybackState(videoEl.currentTime);
}

function finalizeMergedScene(sceneObj) {
  // Construct title representing all categories present in interval
  const primaryTitle = sceneObj.content_types[0];
  const otherTypes = sceneObj.content_types.slice(1);
  const fullTitle = otherTypes.length > 0 ? `${primaryTitle} (+${otherTypes.join(", ")})` : primaryTitle;

  return {
    content_type: fullTitle,
    primary_category: sceneObj.categories[0],
    categories: sceneObj.categories,
    start_time: Math.round(sceneObj.start_time * 100) / 100,
    end_time: Math.round(sceneObj.end_time * 100) / 100,
    duration_sec: Math.round((sceneObj.end_time - sceneObj.start_time) * 100) / 100,
    peak_confidence: sceneObj.peak_confidence,
    sub_events: sceneObj.constituent_events,
  };
}

// Load Timeline JSON (supports category-wise dictionary format or legacy arrays)
async function loadTimelineData() {
  try {
    const res = await fetch("/api/timeline");
    if (res.ok) {
      const data = await res.json();
      parseAndSetTimeline(data);
      return;
    }
  } catch (err) {
    console.warn("Could not fetch /api/timeline:", err);
  }

  parseAndSetTimeline({});
}

function parseAndSetTimeline(data) {
  if (data.categories && typeof data.categories === "object") {
    // New Category-Wise format
    appState.rawCategoryData = data.categories;
  } else if (Array.isArray(data)) {
    // Legacy flat array: convert to category-wise structure
    const converted = {};
    data.forEach((item) => {
      const key = item.raw_label || "INTIMATE_SCENE";
      if (!converted[key]) converted[key] = { intervals: [] };
      converted[key].intervals.push({
        start_time: item.start_time,
        end_time: item.end_time,
        peak_confidence: item.peak_confidence,
      });

      if (item.sub_events) {
        item.sub_events.forEach((sub) => {
          const subKey = sub.raw_label || key;
          if (!converted[subKey]) converted[subKey] = { intervals: [] };
          converted[subKey].intervals.push({
            start_time: sub.start_time,
            end_time: sub.end_time,
            peak_confidence: sub.peak_confidence,
          });
        });
      }
    });
    appState.rawCategoryData = converted;
  } else {
    appState.rawCategoryData = {};
  }

  renderCategoryToggles();
  recomputeDynamicMerging();
}

// Render Color Coded Segments on the Progress Track
function renderTimelineSegments() {
  segmentLayer.innerHTML = "";
  const duration = videoEl.duration;
  if (!duration || duration <= 0) return;

  appState.mergedActiveTimeline.forEach((scene) => {
    const leftPct = (scene.start_time / duration) * 100;
    const widthPct = Math.max(0.6, ((scene.end_time - scene.start_time) / duration) * 100);

    const seg = document.createElement("div");
    seg.className = "timeline-segment";

    const reg = CATEGORY_REGISTRY[scene.primary_category] || { classKey: "nudity", color: "#ef4444" };
    seg.classList.add(reg.classKey);

    seg.style.left = `${leftPct}%`;
    seg.style.width = `${widthPct}%`;
    seg.style.opacity = appState.masterAutoSkip ? "0.95" : "0.35";
    seg.title = `${scene.content_type} (${formatTime(scene.start_time)} - ${formatTime(scene.end_time)})`;

    segmentLayer.appendChild(seg);
  });
}

// Render Detected Scenes in the Sidebar List
function renderIntervalsList() {
  intervalsListContainer.innerHTML = "";
  const scenes = appState.mergedActiveTimeline;
  document.getElementById("total-scenes-counter").textContent = `${scenes.length} Scenes`;

  if (scenes.length === 0) {
    intervalsListContainer.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 24px 0; font-size: 13px;">
        No active violations selected.<br>Enable toggles above to monitor and skip categories.
      </div>
    `;
    return;
  }

  scenes.forEach((item, idx) => {
    const row = document.createElement("div");
    row.className = "interval-row-item";
    row.id = `interval-row-${idx}`;

    const reg = CATEGORY_REGISTRY[item.primary_category] || { color: "#ef4444" };
    const confPct = Math.round((item.peak_confidence || 0) * 100);
    const subText = item.sub_events && item.sub_events.length > 1 ? ` · ${item.sub_events.length} overlaps` : "";

    row.innerHTML = `
      <div class="interval-left">
        <div style="display: flex; align-items: center; gap: 6px;">
          <span style="width: 8px; height: 8px; border-radius: 50%; background: ${reg.color};"></span>
          <span class="interval-title">${item.content_type}</span>
        </div>
        <span class="interval-timestamp">${formatTime(item.start_time)} → ${formatTime(item.end_time)} (${item.duration_sec}s)${subText}</span>
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

// Show Skip Toast
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

// Active Playback Check & Auto-Skip
function checkCurrentPlaybackState(currentTime) {
  let activeScene = null;

  for (let i = 0; i < appState.mergedActiveTimeline.length; i++) {
    const scene = appState.mergedActiveTimeline[i];

    if (currentTime >= scene.start_time && currentTime < scene.end_time) {
      activeScene = scene;
      highlightActiveIntervalRow(i);

      if (appState.masterAutoSkip) {
        // Skip directly to the end of the dynamically merged scene block
        const targetTime = scene.end_time + 0.15;
        videoEl.currentTime = targetTime;
        showSkipNotification(`Auto-Skipped ${scene.content_type} (${formatTime(scene.start_time)} → ${formatTime(scene.end_time)})`);
        return;
      }
      break;
    }
  }

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
  if (el) el.classList.add("active-now");
}

function clearActiveIntervalRows() {
  document.querySelectorAll(".interval-row-item.active-now").forEach((el) => el.classList.remove("active-now"));
}

// Video Time Update
videoEl.addEventListener("timeupdate", () => {
  if (appState.isScrubbing) return;

  const current = videoEl.currentTime;
  const duration = videoEl.duration || 1;

  timeDisplay.textContent = `${formatTime(current)} / ${formatTime(duration)}`;

  const pct = (current / duration) * 100;
  playheadFill.style.width = `${pct}%`;
  scrubberHandle.style.left = `${pct}%`;

  checkCurrentPlaybackState(current);
});

videoEl.addEventListener("loadedmetadata", () => {
  renderTimelineSegments();
  timeDisplay.textContent = `${formatTime(videoEl.currentTime)} / ${formatTime(videoEl.duration)}`;
});

// Interactive Timeline Track Scrubbing
timelineTrack.addEventListener("click", (e) => {
  const rect = timelineTrack.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  videoEl.currentTime = ratio * videoEl.duration;
});

// Master Auto-Skip Toggle
masterSwitch.addEventListener("change", (e) => {
  appState.masterAutoSkip = e.target.checked;
  localStorage.setItem("sentinel_master_skip", appState.masterAutoSkip.toString());
  renderTimelineSegments();
  checkCurrentPlaybackState(videoEl.currentTime);
});

// Local Video File Upload
videoFileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) {
    videoEl.src = URL.createObjectURL(file);
    videoEl.play();
  }
});

// Local JSON File Upload
jsonFileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target.result);
        parseAndSetTimeline(parsed);
      } catch (err) {
        alert("Invalid JSON timeline file: " + err.message);
      }
    };
    reader.readAsText(file);
  }
});

// Init
initPreferences();
loadTimelineData();
