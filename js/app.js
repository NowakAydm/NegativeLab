(() => {
  "use strict";

  const { state, $, activeRoll, activeShot, pad, clamp, notify, beginProgress, updateProgress, endProgress } = window.NegativeLabCore;
  const MAX_BURST_FRAME_COUNT = 16;
  const imageProcessor = window.NegativeLabImageProcessing({ state, $, clamp });
  const { rawToLinear, workingRange } = imageProcessor;
  const curveChannels = ["red", "green", "blue", "white"];
  const defaultCurve = () => [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  const colorMasterCurve = () => [
    { x: 0, y: 0 }, { x: 0.25, y: 0.18 }, { x: 0.5, y: 0.5 },
    { x: 0.75, y: 0.82 }, { x: 1, y: 1 }
  ];
  const bwMasterCurve = () => [
    { x: 0, y: 0 }, { x: 0.3, y: 0.22 }, { x: 0.5, y: 0.5 },
    { x: 0.7, y: 0.78 }, { x: 1, y: 1 }
  ];
  // Raw scan (encoded 0-255) range of each channel. Capture/review use these defaults; Process measures them per roll.
  const DEFAULT_LEVELS = {
    red: { min: 40, max: 235 },
    green: { min: 20, max: 190 },
    blue: { min: 10, max: 130 }
  };
  const LEVELS_OUTLIER_FRACTION = 0.0002;
  const rgbChannels = ["red", "green", "blue"];
  const cloneLevels = (levels) => Object.fromEntries(rgbChannels.map((channel) => [channel, {
    min: Number(levels?.[channel]?.min ?? DEFAULT_LEVELS[channel].min),
    max: Number(levels?.[channel]?.max ?? DEFAULT_LEVELS[channel].max)
  }]));
  const defaultAdjustments = (mode = "color") => ({
    mode,
    brightness: 0,
    contrast: 100,
    hue: 0,
    tint: 0,
    desaturate: mode === "bw",
    gamma: "srgb",
    curvePresetVersion: 4,
    levels: cloneLevels(DEFAULT_LEVELS),
    curves: {
      white: mode === "bw" ? bwMasterCurve() : colorMasterCurve(),
      red: defaultCurve(),
      green: defaultCurve(),
      blue: defaultCurve()
    }
  });
  const adjustmentOptions = [
    ["brightness", "Brightness", -100, 100, 1],
    ["contrast", "Contrast", 0, 200, 1],
    ["hue", "Hue", -180, 180, 1]
  ];
  function normalizeAdjustments(settings) {
    const mode = settings?.mode === "bw" ? "bw" : "color";
    const defaults = defaultAdjustments(mode);
    const normalized = {
      ...defaults,
      ...settings,
      mode,
      hue: Number(settings?.hue ?? 0),
      tint: Number(settings?.tint ?? 0),
      desaturate: settings?.desaturate ?? mode === "bw"
    };
    normalized.levels = cloneLevels(settings?.levels);
    normalized.curves = { ...(settings?.curves || {}) };
    // Before version 4 the RGB curves carried the levels; they are flat now and levels are explicit.
    if (!(settings?.curvePresetVersion >= 4)) {
      rgbChannels.forEach((channel) => { normalized.curves[channel] = defaults.curves[channel]; });
    }
    normalized.curvePresetVersion = 4;
    curveChannels.forEach((channel) => {
      const oldGamma = settings?.[channel];
      const curve = normalized.curves[channel];
      if (Array.isArray(curve)) {
        normalized.curves[channel] = curve.map(({ x, y }) => ({ x, y }));
      } else if (Number.isFinite(oldGamma) && oldGamma > 0) {
        normalized.curves[channel] = Array.from({ length: 5 }, (_, index) => {
          const x = index / 4;
          return { x, y: Math.pow(x, 1 / oldGamma) };
        });
      } else normalized.curves[channel] = defaults.curves[channel];
      delete normalized[channel];
    });
    return normalized;
  }
  state.livePreviewAdjustments = normalizeAdjustments(state.livePreviewAdjustments || defaultAdjustments("color"));
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function updateCssPreview(canvas) {
    canvas.style.filter = "none";
  }
  const video = $("#cameraVideo");
  const capturePreviewCanvas = $("#capturePreviewCanvas");
  const capturePreviewContext = capturePreviewCanvas.getContext("2d");
  const captureSourceCanvas = document.createElement("canvas");
  const captureSourceContext = captureSourceCanvas.getContext("2d", { willReadFrequently: true });
  const captureCanvas = document.createElement("canvas");
  const captureContext = captureCanvas.getContext("2d", { willReadFrequently: true });
  const { processShot, applyAdjustments, applyAdjustmentsSync, buildCurveInputLuts } = imageProcessor;
  const { updateExportState } = window.NegativeLabExport({
    state, $, pad, notify, beginProgress, updateProgress, endProgress, processShot
  });
  const { renderReview } = window.NegativeLabReview({
    state, $, activeRoll, activeShot, pad, clamp, notify, setMode, updateCounts, renderFilmList, makeThumbnail,
    applyPreviewAdjustments: (data) => applyAdjustmentsSync(data, state.livePreviewAdjustments, true),
    updatePreviewFilter: () => updateCssPreview($("#reviewCanvas"))
  });

  function unlockCaptureAudio() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    try {
      state.audioContext ||= new AudioContextClass();
      if (state.audioContext.state === "suspended") state.audioContext.resume().catch(() => { });
    } catch (error) { console.warn("Capture audio is unavailable", error); }
  }

  function playCaptureSound() {
    const context = state.audioContext;
    if (!context) return;
    try {
      if (context.state === "suspended") context.resume().catch(() => { });
      const duration = 0.25;
      const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate);
      const samples = buffer.getChannelData(0);
      for (let index = 0; index < samples.length; index++) samples[index] = Math.random() * 2 - 1;
      const source = context.createBufferSource();
      const filter = context.createBiquadFilter();
      const gain = context.createGain();
      const start = context.currentTime;
      source.buffer = buffer;
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(900, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.02, start + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(context.destination);
      source.start(start);
      source.stop(start + duration);
    } catch (error) { console.warn("Could not play capture sound", error); }
  }

  function updateBurstFrameCountDisplay() {
    const count = state.burstFrameCount;
    const frameLabel = `${count} ${count === 1 ? "frame" : "frames"}`;
    const exposureLabel = `${count} ${count === 1 ? "exposure" : "exposures"}`;
    $("#burstFrameCount").value = count;
    $("#decreaseBurstFrameCount").disabled = count <= 1;
    $("#increaseBurstFrameCount").disabled = count >= MAX_BURST_FRAME_COUNT;
    $("#captureTitle").textContent = `Capture a burst of ${frameLabel}.`;
    $("#captureBurstDescription").innerHTML = `Press <kbd>Space</kbd> or click the button to capture ${exposureLabel}. Adjust the crop manually in Crop.`;
    $("#captureBurstButtonLabel").textContent = `Capture burst · ${frameLabel}`;
  }

  function setBurstFrameCount(value, reportInvalid = false) {
    if (!Number.isInteger(value) || value < 1 || value > MAX_BURST_FRAME_COUNT) {
      $("#burstFrameCount").value = state.burstFrameCount;
      if (reportInvalid) notify(`Choose a whole number between 1 and ${MAX_BURST_FRAME_COUNT} frames per burst.`, true);
      return;
    }
    state.burstFrameCount = value;
    updateBurstFrameCountDisplay();
  }

  $("#burstFrameCount").addEventListener("input", (event) => {
    const value = Number(event.target.value);
    if (event.target.value !== "" && Number.isInteger(value) && value >= 1 && value <= MAX_BURST_FRAME_COUNT) {
      setBurstFrameCount(value);
    }
  });
  $("#burstFrameCount").addEventListener("change", (event) => {
    setBurstFrameCount(Number(event.target.value), true);
  });
  $("#decreaseBurstFrameCount").addEventListener("click", () => setBurstFrameCount(state.burstFrameCount - 1));
  $("#increaseBurstFrameCount").addEventListener("click", () => setBurstFrameCount(state.burstFrameCount + 1));

  function syncCorrectionPanels() {
    $("#captureCorrectionBody").classList.toggle("hidden", !$("#captureNegativeToggle").checked);
    $("#reviewCorrectionBody").classList.toggle("hidden", !$("#reviewNegativeToggle").checked);
    drawCurveEditors();
  }
  $("#captureNegativeToggle").addEventListener("change", syncCorrectionPanels);
  $("#reviewNegativeToggle").addEventListener("change", syncCorrectionPanels);

  document.addEventListener("keydown", (event) => {
    if ((state.mode !== "review" && state.mode !== "process") || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (event.target.closest("input, select, textarea, [contenteditable='true']")) return;
    if (!activeRoll().shots.length) return;
    event.preventDefault();
    if (state.mode === "process") {
      selectProcessShot(state.selectedShotIndex + (event.key === "ArrowLeft" ? -1 : 1));
      return;
    }
    $(event.key === "ArrowLeft" ? "#previousShotButton" : "#nextShotButton").click();
  });

  document.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target.closest("input, select, textarea, button, [contenteditable='true']")) return;
    if (state.mode !== "capture") return;
    event.preventDefault();
    unlockCaptureAudio();
    captureBurst();
  });

  function updateCounts() {
    const roll = activeRoll();
    $("#headerRoll").textContent = roll.number;
    $("#headerShot").textContent = roll.shots.length + 1;
    if (document.activeElement !== $("#rollNumberInput")) $("#rollNumberInput").value = roll.number;
    roll.name ||= `Roll ${pad(roll.number)}`;
    if (document.activeElement !== $("#rollNameInput")) $("#rollNameInput").value = roll.name;
    $("#shotCount").textContent = roll.shots.length;
    $("#reviewRoll").textContent = pad(roll.number);
    $("#captureRoll").textContent = pad(roll.number);
    renderFilmList();
    renderRollList();
  }

  function renderRollList() {
    const list = $("#rollList");
    list.replaceChildren();
    state.rolls.forEach((roll, index) => {
      const item = document.createElement("button");
      item.className = `film-item${index === state.rollIndex ? " selected" : ""}`;
      item.type = "button";
      item.setAttribute("aria-label", `Select roll ${roll.number}`);
      const marker = document.createElement("span");
      marker.className = "badge";
      marker.textContent = pad(roll.number);
      const detail = document.createElement("span");
      const name = document.createElement("span");
      name.className = "eyebrow";
      name.textContent = roll.name || `Roll ${pad(roll.number)}`;
      const count = document.createElement("span");
      count.className = "mt-1 block text-[10px] subtle";
      count.textContent = `${roll.shots.length} frame(s)`;
      detail.append(name, count);
      item.append(marker, detail);
      item.addEventListener("click", () => {
        state.rollIndex = index;
        state.selectedShotIndex = Math.max(0, roll.shots.length - 1);
        updateCounts();
        if (state.mode === "review") renderReview();
        if (state.mode === "process") { updateProcessState(); updateProcessPreview(); }
      });
      list.append(item);
    });
  }

  function ensureShotVisible(list, item) {
    if (!item) return;
    const listRect = list.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    if (itemRect.top < listRect.top) list.scrollTop -= Math.ceil(listRect.top - itemRect.top);
    else if (itemRect.bottom > listRect.bottom) list.scrollTop += Math.ceil(itemRect.bottom - listRect.bottom);
  }

  function renderFilmList() {
    const list = $("#filmList");
    list.replaceChildren();
    const shots = activeRoll().shots;
    $("#emptyFilmList").classList.toggle("hidden", shots.length > 0);
    shots.forEach((shot, index) => {
      const item = document.createElement("button");
      item.className = `film-item${index === state.selectedShotIndex && (state.mode === "review" || state.mode === "process") ? " selected" : ""}`;
      item.type = "button";
      item.setAttribute("aria-label", `Crop shot ${shot.number}`);
      const image = document.createElement("img");
      image.className = "film-thumb";
      image.src = shot.thumbnail;
      image.alt = "";
      const detail = document.createElement("span");
      detail.innerHTML = `<span class="eyebrow">Shot ${pad(shot.number)}</span><span class="mt-1 block text-[10px] subtle">${shot.frameCount} frame burst</span>`;
      if (shot.flipX || shot.flipY) {
        const flip = document.createElement("span");
        flip.className = "flip-indicators";
        flip.setAttribute("aria-label", `Flipped ${[shot.flipX && "horizontally", shot.flipY && "vertically"].filter(Boolean).join(" and ")}`);
        flip.textContent = `${shot.flipX ? "↔" : ""}${shot.flipY ? "↕" : ""}`;
        detail.append(flip);
      }
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = pad(shot.number);
      item.append(image, detail, badge);
      item.dataset.shotIndex = index;
      item.addEventListener("click", () => {
        if (state.mode === "process") { selectProcessShot(index); return; }
        state.selectedShotIndex = index;
        setMode("review");
        ensureShotVisible(list, list.querySelector(".film-item.selected"));
      });
      list.prepend(item);
    });
    if (state.mode === "review" || state.mode === "process") {
      ensureShotVisible(list, list.querySelector(`[data-shot-index="${state.selectedShotIndex}"]`));
    }
  }

  function setMode(mode) {
    state.mode = mode;
    $(".capture-layout").classList.toggle("review-mode", mode === "review" || mode === "process");
    $(".capture-layout").classList.toggle("process-mode", mode === "process");
    $("#rightSidebar").dataset.mode = mode;
    document.querySelectorAll("[data-sidebar-mode]").forEach((panel) => {
      const active = panel.dataset.sidebarMode === mode;
      panel.hidden = !active;
      panel.setAttribute("aria-hidden", String(!active));
    });
    $("#doneButton").classList.toggle("hidden", mode === "process");
    const nextLabels = { setup: "Continue to Capture →", capture: "Crop Roll →", review: "Develop Roll →" };
    $("#doneButton").textContent = nextLabels[mode] || "";
    document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `${mode}View`));
    document.querySelectorAll(".mode-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.mode === mode));
    if (mode === "review") renderReview();
    if (mode === "process") {
      if (activeRoll().shots.length) activeRoll().previewShotIndex = clamp(state.selectedShotIndex, 0, activeRoll().shots.length - 1);
      state.previewBaseKey = "";
      state.previewBaseData = null;
      state.previewHistogram = null;
      updateProcessState();
      scanRollLevels().finally(() => { if (state.mode === "process") { updateProcessState(); updateProcessPreview(); } });
    }
    if (mode === "process") updateExportState();
    renderFilmList();
  }

  document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));

  document.querySelectorAll("[data-resize]").forEach((resizer) => {
    let startX = 0;
    let startWidth = 0;
    const side = resizer.dataset.resize;
    const cssProperty = side === "left" ? "--left-pane-width" : "--right-pane-width";
    const limits = side === "left" ? [180, 420] : [250, 520];
    const readWidth = () => Number.parseFloat(getComputedStyle($(".capture-layout")).getPropertyValue(cssProperty)) || (side === "left" ? 250 : 340);
    const updateWidth = (width) => {
      const value = clamp(Math.round(width), limits[0], limits[1]);
      $(".capture-layout").style.setProperty(cssProperty, `${value}px`);
      resizer.setAttribute("aria-valuenow", String(value));
    };
    resizer.addEventListener("pointerdown", (event) => {
      startX = event.clientX;
      startWidth = readWidth();
      resizer.classList.add("dragging");
      resizer.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    resizer.addEventListener("pointermove", (event) => {
      if (!resizer.hasPointerCapture(event.pointerId)) return;
      const direction = side === "left" ? 1 : -1;
      updateWidth(startWidth + (event.clientX - startX) * direction);
    });
    const finishResize = () => {
      resizer.classList.remove("dragging");
      window.dispatchEvent(new Event("resize"));
    };
    resizer.addEventListener("pointerup", finishResize);
    resizer.addEventListener("pointercancel", finishResize);
    resizer.addEventListener("keydown", (event) => {
      if (event.key === "Home") updateWidth(limits[0]);
      else if (event.key === "End") updateWidth(limits[1]);
      else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const direction = event.key === "ArrowRight" ? 1 : -1;
        updateWidth(readWidth() + direction * (event.shiftKey ? 32 : 12) * (side === "left" ? 1 : -1));
      } else return;
      event.preventDefault();
      window.dispatchEvent(new Event("resize"));
    });
    resizer.addEventListener("dblclick", () => {
      updateWidth(side === "left" ? 250 : 340);
      window.dispatchEvent(new Event("resize"));
    });
  });
  $("#doneButton").addEventListener("click", () => {
    const nextMode = { setup: "capture", capture: "review", review: "process" }[state.mode];
    if (!nextMode) return;
    if (state.mode === "capture" && !activeRoll().shots.length) { notify("Capture at least one frame before reviewing this roll.", true); return; }
    state.selectedShotIndex = clamp(state.selectedShotIndex, 0, Math.max(0, activeRoll().shots.length - 1));
    setMode(nextMode);
  });
  $("#nextRollButton").addEventListener("click", () => {
    const nextNumber = Math.max(...state.rolls.map((roll) => roll.number)) + 1;
    state.rolls.push({ number: nextNumber, name: `Roll ${pad(nextNumber)}`, shots: [], adjustments: defaultAdjustments(), previewShotIndex: 0 });
    state.rollIndex = state.rolls.length - 1;
    state.selectedShotIndex = 0;
    setMode("capture");
    updateCounts();
  });
  $("#rollNameInput").addEventListener("change", (event) => {
    const name = event.target.value.trim();
    if (!name) {
      event.target.value = activeRoll().name || `Roll ${pad(activeRoll().number)}`;
      notify("A roll name cannot be empty.", true);
      return;
    }
    activeRoll().name = name;
    renderRollList();
    updateExportState();
  });
  $("#rollNumberInput").addEventListener("change", (event) => {
    const number = Number(event.target.value);
    if (!Number.isInteger(number) || number < 1 || number > 9999
      || state.rolls.some((roll, index) => index !== state.rollIndex && roll.number === number)) {
      event.target.value = activeRoll().number;
      notify("Choose a unique roll number between 1 and 9999.", true);
      return;
    }
    const roll = activeRoll();
    const previousDefaultName = `Roll ${pad(roll.number)}`;
    if (!roll.name || roll.name === previousDefaultName) roll.name = `Roll ${pad(number)}`;
    roll.number = number;
    updateCounts();
    if (state.mode === "process") updateProcessState();
    updateExportState();
  });

  async function enumerateCameras() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter((device) => device.kind === "videoinput");
      const select = $("#cameraSelect");
      const selected = select.value;
      select.replaceChildren(new Option("Default camera", ""));
      cameras.forEach((camera, index) => select.add(new Option(camera.label || `Camera ${index + 1}`, camera.deviceId)));
      if (cameras.some((camera) => camera.deviceId === selected)) select.value = selected;
    } catch (error) { console.warn("Could not enumerate cameras", error); }
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      notify("Camera access is unavailable in this browser context. Try localhost or HTTPS; some browsers block camera access from file:// pages.", true);
      return;
    }
    const progressId = beginProgress("Starting camera", "Requesting access to the selected camera…");
    stopCamera();
    const resolutionSetting = $("#resolutionSelect").value;
    const requestedSize = resolutionSetting === "device" ? null : resolutionSetting.split("x").map(Number);
    const deviceId = $("#cameraSelect").value;
    const resolutions = requestedSize
      ? [requestedSize, [1920, 1080], [1280, 720], [640, 480]]
        .filter(([candidateWidth, candidateHeight], index, list) =>
          candidateWidth <= requestedSize[0] && candidateHeight <= requestedSize[1] &&
          list.findIndex(([otherWidth, otherHeight]) => otherWidth === candidateWidth && otherHeight === candidateHeight) === index)
      : [null];
    let lastError;
    try {
      for (const [index, resolution] of resolutions.entries()) {
        updateProgress(progressId, `Connecting to camera${resolutions.length > 1 ? ` · resolution attempt ${index + 1} of ${resolutions.length}` : ""}`, 8 + index / resolutions.length * 35);
        const videoConstraint = {};
        if (resolution) {
          const [candidateWidth, candidateHeight] = resolution;
          Object.assign(videoConstraint, {
            width: { ideal: candidateWidth, max: candidateWidth },
            height: { ideal: candidateHeight, max: candidateHeight },
            frameRate: { ideal: 30, max: 60 }
          });
        }
        if (deviceId) videoConstraint.deviceId = { exact: deviceId };
        try {
          state.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraint });
          break;
        } catch (error) {
          lastError = error;
          if (["NotAllowedError", "NotFoundError", "SecurityError"].includes(error.name)) throw error;
        }
      }
      if (!state.stream) throw lastError || new Error("No compatible camera mode was found.");
      updateProgress(progressId, "Camera connected · starting live preview…", 55);
      video.srcObject = state.stream;
      await video.play();
      updateProgress(progressId, "Reading camera settings…", 85);
      await enumerateCameras();
      const track = state.stream.getVideoTracks()[0];
      const settings = track.getSettings();
      $("#liveLabel").textContent = "Live · camera connected";
      const actualWidth = settings.width || video.videoWidth;
      const actualHeight = settings.height || video.videoHeight;
      const loweredResolution = requestedSize && (actualWidth < requestedSize[0] || actualHeight < requestedSize[1]);
      $("#resolutionReadout").textContent = `${actualWidth} × ${actualHeight}${loweredResolution ? " · fallback" : ""}`;
      $("#captureStatus").textContent = loweredResolution
        ? `Camera ready at ${actualWidth} × ${actualHeight}; the requested resolution was unavailable. Place a negative in view and continue to capture.`
        : resolutionSetting === "device"
          ? `Camera ready using device settings at ${actualWidth} × ${actualHeight}. Place a negative in view and continue to capture.`
          : "Camera ready. Place a negative in view and continue to capture.";
      $("#captureNowButton").disabled = false;
      $("#startCameraButton").textContent = "Restart camera";
      updateProgress(progressId, `Camera ready · ${actualWidth} × ${actualHeight}`, 100);
    } catch (error) {
      let message;
      if (error.name === "NotAllowedError" || error.name === "SecurityError") {
        message = "Camera permission was denied. Allow camera access in your browser and try again.";
      } else if (error.name === "NotFoundError") {
        message = "The selected video source was not found. Refresh the camera list and select the converter's webcam output.";
      } else if (error.name === "NotReadableError" || /allocate videosource/i.test(error.message)) {
        const sourceLabel = $("#cameraSelect").selectedOptions[0]?.textContent || "The selected camera";
        message = sourceLabel.startsWith("Z CAM")
          ? `${sourceLabel} is visible to the browser, but its virtual-camera stream would not start. In the converter, confirm the selected Stream Index has an active feed, close apps using the virtual camera, then restart the converter and retry.`
          : "The selected camera is visible to the browser but could not start. Close apps using it, reconnect or restart its camera software, then retry.";
      } else {
        message = `Could not start camera: ${error.message}`;
      }
      $("#captureStatus").textContent = message;
      notify(message, true);
    } finally {
      endProgress(progressId);
    }
  }

  function stopCamera() {
    if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
    video.srcObject = null;
    $("#captureNowButton").disabled = true;
    $("#liveLabel").textContent = "Camera offline";
  }

  $("#startCameraButton").addEventListener("click", startCamera);
  $("#startCameraButton").addEventListener("click", unlockCaptureAudio);
  $("#cameraSelect").addEventListener("change", () => { if (state.stream) startCamera(); });
  $("#resolutionSelect").addEventListener("change", () => { if (state.stream) startCamera(); });
  navigator.mediaDevices?.addEventListener?.("devicechange", enumerateCameras);
  enumerateCameras();

  function capturePreviewLoop(now) {
    requestAnimationFrame(capturePreviewLoop);
    if (!state.stream || state.capturing || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const scale = Math.min(1, 1280 / video.videoWidth, 900 / video.videoHeight);
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    if (captureSourceCanvas.width !== width || captureSourceCanvas.height !== height) {
      captureSourceCanvas.width = width;
      captureSourceCanvas.height = height;
      capturePreviewCanvas.width = width;
      capturePreviewCanvas.height = height;
    }
    captureSourceContext.drawImage(video, 0, 0, width, height);
    if (!$("#captureNegativeToggle").checked) {
      capturePreviewContext.drawImage(captureSourceCanvas, 0, 0);
      return;
    }
    const settings = state.livePreviewAdjustments;
    const key = JSON.stringify(settings);
    if (key !== state.capturePreviewKey) {
      state.capturePreviewKey = key;
      state.capturePreviewLastRenderAt = 0;
    }
    if (state.capturePreviewBusy || now - (state.capturePreviewLastRenderAt || 0) < 120) return;
    state.capturePreviewBusy = true;
    state.capturePreviewLastRenderAt = now;
    const sequence = (state.capturePreviewSequence || 0) + 1;
    state.capturePreviewSequence = sequence;
    try {
      const image = captureSourceContext.getImageData(0, 0, width, height);
      applyAdjustments(image.data, settings, true).then(() => {
        if (sequence === state.capturePreviewSequence && state.capturePreviewKey === key) {
          capturePreviewContext.putImageData(image, 0, 0);
        }
      }).catch((error) => notify(`Capture preview adjustment failed: ${error.message}`, true))
        .finally(() => { state.capturePreviewBusy = false; });
    } catch (error) {
      state.capturePreviewBusy = false;
      notify(`Capture preview could not be rendered: ${error.message}`, true);
    }
  }

  function updateCapturePreviewFilter() {
    const settings = state.livePreviewAdjustments;
    settings.brightness = Number($("#captureBrightness").value);
    settings.contrast = Number($("#captureContrast").value);
    settings.hue = Number($("#captureHue").value);
    $("#captureBrightnessLabel").textContent = String(settings.brightness);
    $("#captureContrastLabel").textContent = `${settings.contrast}%`;
    $("#captureHueLabel").textContent = `${settings.hue}°`;
    $("#reviewBrightness").value = settings.brightness;
    $("#reviewContrast").value = settings.contrast;
    $("#reviewHue").value = settings.hue;
    $("#reviewBrightnessLabel").textContent = String(settings.brightness);
    $("#reviewContrastLabel").textContent = `${settings.contrast}%`;
    $("#reviewHueLabel").textContent = `${settings.hue}°`;
    updateCssPreview(capturePreviewCanvas);
    updateCssPreview($("#reviewCanvas"));
    state.capturePreviewKey = "";
    renderReview();
  }

  function changeLivePreviewMode(mode) {
    const settings = state.livePreviewAdjustments;
    settings.mode = mode === "bw" ? "bw" : "color";
    settings.desaturate = settings.mode === "bw";
    settings.curves = defaultAdjustments(settings.mode).curves;
    settings.gamma = defaultAdjustments(settings.mode).gamma;
    $("#capturePreviewMode").value = settings.mode;
    $("#reviewPreviewMode").value = settings.mode;
    drawCurveEditors();
    updateCapturePreviewFilter();
  }

  ["captureBrightness", "captureContrast", "captureHue"].forEach((id) => {
    $("#" + id).addEventListener("input", updateCapturePreviewFilter);
  });
  $("#captureNegativeToggle").addEventListener("change", updateCapturePreviewFilter);
  ["capturePreviewMode", "reviewPreviewMode"].forEach((id) => {
    $("#" + id).addEventListener("change", (event) => changeLivePreviewMode(event.target.value));
  });
  $("#reviewBrightness").addEventListener("input", () => {
    $("#captureBrightness").value = $("#reviewBrightness").value;
    updateCapturePreviewFilter();
  });
  $("#reviewContrast").addEventListener("input", () => {
    $("#captureContrast").value = $("#reviewContrast").value;
    updateCapturePreviewFilter();
  });
  $("#reviewHue").addEventListener("input", () => {
    $("#captureHue").value = $("#reviewHue").value;
    updateCapturePreviewFilter();
  });
  updateCapturePreviewFilter();

  function frameToPixels() {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error("The camera has no readable frame yet.");
    if (captureCanvas.width !== width || captureCanvas.height !== height) {
      captureCanvas.width = width;
      captureCanvas.height = height;
    }
    captureContext.drawImage(video, 0, 0, width, height);
    return { width, height, pixels: captureContext.getImageData(0, 0, width, height).data };
  }

  async function captureBurst() {
    if (state.capturing || !state.stream) return;
    const frameCount = state.burstFrameCount;
    state.capturing = true;
    document.body.classList.remove("capture-ready");
    document.body.classList.add("capture-busy");
    let succeeded = false;
    const progressId = beginProgress("Capturing burst", `Preparing the camera for a ${frameCount}-frame burst…`);
    $("#captureNowButton").disabled = true;
    $("#captureStatusCapture").textContent = `Capturing ${frameCount} frame${frameCount === 1 ? "" : "s"}…`;
    try {
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      let corners = null;
      let thumbnail = "";
      let width = 0;
      let height = 0;
      // Running sum of the burst; only allocated when more than one frame is captured.
      let sum = null;
      let pixels = null;
      for (let index = 0; index < frameCount; index++) {
        if (index) await new Promise((resolve) => setTimeout(resolve, 60));
        updateProgress(progressId, `Capturing frame ${index + 1} of ${frameCount}`, index / frameCount * 100);
        const frame = frameToPixels();
        width = frame.width;
        height = frame.height;
        corners ||= [
          { x: frame.width * .08, y: frame.height * .08 },
          { x: frame.width * .92, y: frame.height * .08 },
          { x: frame.width * .92, y: frame.height * .92 },
          { x: frame.width * .08, y: frame.height * .92 }
        ];
        if (!index) {
          thumbnail = makeThumbnail({ width: frame.width, height: frame.height, quad: corners }, captureCanvas);
        }
        if (frameCount === 1) {
          pixels = frame.pixels;
        } else {
          sum ||= new Uint16Array(frame.pixels.length);
          const framePixels = frame.pixels;
          for (let i = 0; i < sum.length; i++) sum[i] += framePixels[i];
        }
        $("#captureStatusCapture").textContent = `Capturing frame ${index + 1} of ${frameCount}`;
      }
      if (sum) {
        // Averaging happens here so each shot keeps a single 8-bit RGBA asset instead of every burst frame.
        pixels = new Uint8ClampedArray(sum.length);
        for (let i = 0; i < sum.length; i++) pixels[i] = Math.round(sum[i] / frameCount);
        sum = null;
      }
      const shot = { number: activeRoll().shots.length + 1, width, height, pixels, frameCount, quad: corners.map(({ x, y }) => ({ x, y })), autoQuad: corners.map(({ x, y }) => ({ x, y })), filmGuides: null, autoFilmGuides: null, filmCrop: null, adjustMode: "corners", flipX: false, flipY: false, thumbnail, createdAt: Date.now() };
      activeRoll().shots.push(shot);
      state.selectedShotIndex = activeRoll().shots.length - 1;
      $("#scanFlash").classList.remove("fire");
      void $("#scanFlash").offsetWidth;
      $("#scanFlash").classList.add("fire");
      playCaptureSound();
      $("#captureStatusCapture").textContent = `Shot ${pad(shot.number)} captured · ${frameCount}-frame burst saved.`;
      updateProgress(progressId, "Burst captured", 100);
      updateCounts();
      succeeded = true;
    } catch (error) {
      notify(`Burst capture failed: ${error.message}`, true);
      $("#captureStatus").textContent = "Capture failed. Check available memory and camera access.";
    } finally {
      state.capturing = false;
      document.body.classList.remove("capture-busy");
      if (succeeded) {
        void document.body.offsetWidth;
        document.body.classList.add("capture-ready");
        setTimeout(() => document.body.classList.remove("capture-ready"), 1000);
      }
      $("#captureNowButton").disabled = !state.stream;
      endProgress(progressId);
    }
  }

  function makeThumbnail(shot, sourceCanvas = null) {
    let thumb = sourceCanvas;
    if (!thumb) {
      thumb = document.createElement("canvas");
      thumb.width = shot.width;
      thumb.height = shot.height;
      thumb.getContext("2d", { willReadFrequently: true }).putImageData(new ImageData(shot.pixels, shot.width, shot.height), 0, 0);
    }
    const result = document.createElement("canvas");
    result.width = 120;
    result.height = 80;
    const bounds = shot.quad.reduce((rect, point) => ({
      left: Math.min(rect.left, point.x),
      top: Math.min(rect.top, point.y),
      right: Math.max(rect.right, point.x),
      bottom: Math.max(rect.bottom, point.y)
    }), { left: shot.width, top: shot.height, right: 0, bottom: 0 });
    result.getContext("2d").drawImage(thumb, bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top, 0, 0, 120, 80);
    return result.toDataURL("image/jpeg", .72);
  }

  $("#captureNowButton").addEventListener("click", captureBurst);
  $("#captureNowButton").addEventListener("click", unlockCaptureAudio);

  // Imported files become single-frame shots covering the whole image, so they can be reviewed and processed like captures.
  async function importImages(files) {
    if (state.capturing || !files.length) return;
    const roll = activeRoll();
    let imported = 0;
    for (const file of files) {
      let bitmap = null;
      let canvas = null;
      try {
        bitmap = await createImageBitmap(file);
        const width = bitmap.width;
        const height = bitmap.height;
        canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(bitmap, 0, 0);
        const pixels = context.getImageData(0, 0, width, height).data;
        const quad = [
          { x: 0, y: 0 },
          { x: width - 1, y: 0 },
          { x: width - 1, y: height - 1 },
          { x: 0, y: height - 1 }
        ];
        const thumbnail = makeThumbnail({ width, height, quad }, canvas);
        roll.shots.push({
          number: roll.shots.length + 1,
          width,
          height,
          pixels,
          frameCount: 1,
          quad,
          autoQuad: quad.map(({ x, y }) => ({ x, y })),
          filmGuides: null,
          autoFilmGuides: null,
          filmCrop: null,
          adjustMode: "corners",
          flipX: false,
          flipY: false,
          thumbnail,
          createdAt: Date.now(),
          importedFrom: file.name
        });
        imported++;
      } catch (error) {
        notify(`Could not import ${file.name}: ${error.message}`, true);
      } finally {
        bitmap?.close();
        if (canvas) canvas.width = canvas.height = 0;
      }
    }
    if (imported) {
      state.selectedShotIndex = roll.shots.length - 1;
      updateCounts();
      $("#captureStatusCapture").textContent = `${imported} image${imported === 1 ? "" : "s"} imported.`;
    }
  }

  $("#importShotButton").addEventListener("click", () => $("#importShotInput").click());
  $("#importShotInput").addEventListener("change", async (event) => {
    const files = [...event.target.files];
    event.target.value = "";
    await importImages(files);
  });
  

  function activeAdjustmentSettings() {
    const roll = activeRoll();
    const shot = roll.shots[roll.previewShotIndex || 0];
    roll.adjustments = normalizeAdjustments(roll.adjustments);
    if (shot?.adjustments) shot.adjustments = normalizeAdjustments(shot.adjustments);
    return $("#previewAdjustmentsToggle").checked && shot?.adjustments
      ? shot.adjustments
      : roll.adjustments;
  }

  function getAdjustmentSettings() {
    return activeAdjustmentSettings();
  }

  function drawCurveEditor(canvas, settings, histogram = null) {
    const context = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    const margin = 13;
    const graphWidth = width - margin * 2;
    const graphHeight = height - margin * 2;
    const channel = canvas.dataset.curveChannel;
    const colors = { white: "#e9ece7", red: "#ff746b", green: "#83d884", blue: "#72a8ff" };
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#171b18";
    context.fillRect(margin, margin, graphWidth, graphHeight);
    context.strokeStyle = "rgba(144,153,145,.22)";
    context.lineWidth = 1;
    for (let step = 0; step <= 4; step++) {
      const x = margin + graphWidth * step / 4;
      const y = margin + graphHeight * step / 4;
      context.beginPath();
      context.moveTo(x, margin);
      context.lineTo(x, height - margin);
      context.moveTo(margin, y);
      context.lineTo(width - margin, y);
      context.stroke();
    }
    context.fillStyle = "#909991";
    context.font = "8px sans-serif";
    let lowLabel = "0";
    let highLabel = "255";
    if (channel !== "white") {
      const invert = canvas.dataset.curveScope === "process" ? $("#invertToggle").checked : true;
      const range = workingRange(settings.levels?.[channel], invert);
      lowLabel = String(range.min);
      highLabel = String(range.max);
    }
    context.fillText(lowLabel, margin, height - 2);
    context.fillText(highLabel, width - margin - 18, height - 2);
    context.fillText("255", 0, margin + 3);
    if (histogram) {
      const peak = Math.max(...histogram, 1);
      context.beginPath();
      histogram.forEach((count, index) => {
        const x = margin + graphWidth * index / 255;
        const y = height - margin - graphHeight * count / peak;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.lineTo(width - margin, height - margin);
      context.lineTo(margin, height - margin);
      context.closePath();
      context.fillStyle = `${colors[channel]}55`;
      context.fill();
    }
    const points = settings.curves[channel];
    context.fillStyle = "#afb8b0";
    context.font = "bold 9px sans-serif";
    context.fillText(channel === "white" ? "Master (W)" : channel.toUpperCase(), margin + 4, margin + 12);
    context.beginPath();
    points.forEach(({ x, y }, index) => {
      const pixelX = margin + x * graphWidth;
      const pixelY = height - margin - y * graphHeight;
      if (index === 0) context.moveTo(pixelX, pixelY);
      else context.lineTo(pixelX, pixelY);
    });
    context.strokeStyle = colors[channel];
    context.lineWidth = 2;
    context.stroke();
    points.forEach(({ x, y }) => {
      context.beginPath();
      context.arc(margin + x * graphWidth, height - margin - y * graphHeight, 4, 0, Math.PI * 2);
      context.fillStyle = "#111412";
      context.fill();
      context.strokeStyle = colors[channel];
      context.lineWidth = 1.5;
      context.stroke();
    });
  }

  function drawCurveEditors() {
    document.querySelectorAll("[data-curve-channel][data-curve-scope]").forEach((canvas) => {
      const processEditor = canvas.dataset.curveScope === "process";
      const settings = processEditor ? getAdjustmentSettings() : state.livePreviewAdjustments;
      const channel = canvas.dataset.curveChannel;
      const histogram = processEditor ? state.previewHistogram?.[channel] : null;
      drawCurveEditor(canvas, settings, histogram);
      const editor = canvas.closest(".curve-editor");
      editor.querySelector("[data-curve-title]").textContent = channel === "white" ? "Master (W) curve" : `${channel} curve`;
      editor.querySelectorAll("[data-curve-select]").forEach((button) => {
        const selected = button.dataset.curveSelect === channel;
        button.setAttribute("aria-pressed", String(selected));
        button.classList.toggle("active", selected);
      });
      const levels = editor.querySelector("[data-level-controls]");
      levels.hidden = channel === "white";
      if (channel !== "white") {
        const range = workingRange(settings.levels[channel], processEditor ? $("#invertToggle").checked : true);
        levels.querySelector(".levels-label").textContent = `${channel} input range`;
        const minimum = levels.querySelector('[data-level-bound="min"]');
        const maximum = levels.querySelector('[data-level-bound="max"]');
        minimum.dataset.levelChannel = channel;
        maximum.dataset.levelChannel = channel;
        minimum.setAttribute("aria-label", `${channel} minimum`);
        maximum.setAttribute("aria-label", `${channel} maximum`);
        minimum.value = range.min;
        maximum.value = range.max;
      }
    });
  }

  function curvePointFromEvent(canvas, event) {
    const rect = canvas.getBoundingClientRect();
    const horizontalInset = 13 / canvas.width;
    const verticalInset = 13 / canvas.height;
    return {
      x: clamp(((event.clientX - rect.left) / rect.width - horizontalInset) / (1 - horizontalInset * 2), 0, 1),
      y: clamp(1 - ((event.clientY - rect.top) / rect.height - verticalInset) / (1 - verticalInset * 2), 0, 1)
    };
  }

  function bindCurveEditor(canvas, getSettings, onChange) {
    let draggingPoint = -1;
    function getPoints() {
      return getSettings().curves[canvas.dataset.curveChannel];
    }
    function pointIndexAt(point, points) {
      const rect = canvas.getBoundingClientRect();
      const graphWidth = rect.width * (1 - 26 / canvas.width);
      const graphHeight = rect.height * (1 - 26 / canvas.height);
      return points.findIndex((candidate) =>
        Math.hypot((candidate.x - point.x) * graphWidth, (candidate.y - point.y) * graphHeight) < 12
      );
    }
    function changed() {
      drawCurveEditors();
      onChange();
    }
    canvas.addEventListener("pointerdown", (event) => {
      const points = getPoints();
      const point = curvePointFromEvent(canvas, event);
      if (event.ctrlKey) {
        event.preventDefault();
        const index = pointIndexAt(point, points);
        if (index > 0 && index < points.length - 1) {
          points.splice(index, 1);
          changed();
        }
        return;
      }
      draggingPoint = pointIndexAt(point, points);
      if (draggingPoint >= 0) {
        canvas.setPointerCapture(event.pointerId);
        event.preventDefault();
      }
    });
    canvas.addEventListener("pointermove", (event) => {
      if (draggingPoint < 0) return;
      const points = getPoints();
      const point = curvePointFromEvent(canvas, event);
      const minimumX = draggingPoint === 0 ? 0 : points[draggingPoint - 1].x + .005;
      const maximumX = draggingPoint === points.length - 1 ? 1 : points[draggingPoint + 1].x - .005;
      points[draggingPoint] = {
        x: draggingPoint === 0 ? 0 : draggingPoint === points.length - 1 ? 1 : clamp(point.x, minimumX, maximumX),
        y: point.y
      };
      changed();
    });
    canvas.addEventListener("pointerup", () => { draggingPoint = -1; });
    canvas.addEventListener("pointercancel", () => { draggingPoint = -1; });
    canvas.addEventListener("dblclick", (event) => {
      const points = getPoints();
      const point = curvePointFromEvent(canvas, event);
      if (pointIndexAt(point, points) >= 0) return;
      const insertionIndex = points.findIndex((candidate) => candidate.x > point.x);
      const index = insertionIndex < 0 ? points.length : insertionIndex;
      const minimumX = index === 0 ? 0 : points[index - 1].x + .005;
      const maximumX = index === points.length ? 1 : points[index].x - .005;
      if (minimumX > maximumX) return;
      point.x = clamp(point.x, minimumX, maximumX);
      points.splice(index, 0, point);
      changed();
    });
  }

  function createCurveEditors(container, scope, getSettings, onChange) {
    container.innerHTML = `<div class="curve-editors"><div class="curve-editor">` +
      `<div class="curve-editor-title"><span data-curve-title>red curve</span><span class="subtle">Input → output</span></div>` +
      `<div class="curve-channel-buttons" role="group" aria-label="Select tone curve">` +
      `<button class="curve-channel-button active" type="button" data-curve-select="red" aria-label="Red curve" aria-pressed="true">R</button>` +
      `<button class="curve-channel-button" type="button" data-curve-select="green" aria-label="Green curve" aria-pressed="false">G</button>` +
      `<button class="curve-channel-button" type="button" data-curve-select="blue" aria-label="Blue curve" aria-pressed="false">B</button>` +
      `<button class="curve-channel-button" type="button" data-curve-select="white" aria-label="White curve" aria-pressed="false">W</button></div>` +
      `<canvas width="320" height="320" data-curve-scope="${scope}" data-curve-channel="red" aria-label="Red tone curve editor"></canvas>` +
      `<div class="levels-row" data-level-controls><span class="levels-label">red input range</span>` +
      `<label>Min <input type="number" min="0" max="254" step="1" class="field-select" data-level-channel="red" data-level-bound="min" aria-label="red minimum"></label>` +
      `<label>Max <input type="number" min="1" max="255" step="1" class="field-select" data-level-channel="red" data-level-bound="max" aria-label="red maximum"></label></div></div></div>`;
    const canvas = container.querySelector("[data-curve-channel]");
    bindCurveEditor(canvas, getSettings, onChange);
    container.querySelectorAll("[data-curve-select]").forEach((button) => {
      button.addEventListener("click", () => {
        canvas.dataset.curveChannel = button.dataset.curveSelect;
        canvas.setAttribute("aria-label", `${button.getAttribute("aria-label")} tone curve editor`);
        drawCurveEditors();
      });
    });
    if (scope !== "process") {
      container.addEventListener("change", (event) => {
        const input = event.target.closest("[data-level-channel]");
        if (!input) return;
        const channel = input.dataset.levelChannel;
        const field = (bound) => container.querySelector(`[data-level-channel="${channel}"][data-level-bound="${bound}"]`);
        const low = clamp(Math.round(Number(field("min").value) || 0), 0, 254);
        const high = clamp(Math.round(Number(field("max").value) || 255), low + 1, 255);
        getSettings().levels[channel] = { min: 255 - high, max: 255 - low };
        onChange();
      });
    }
  }

  function histogramFor(imageData, invert, settings) {
    const histogram = Object.fromEntries(curveChannels.map((channel) => [channel, new Uint32Array(256)]));
    const curveInputs = buildCurveInputLuts(settings, invert);
    for (let index = 0; index < imageData.data.length; index += 4) {
      const redInput = Math.round(curveInputs.redInput[imageData.data[index]]);
      const greenInput = Math.round(curveInputs.greenInput[imageData.data[index + 1]]);
      const blueInput = Math.round(curveInputs.blueInput[imageData.data[index + 2]]);
      const redOutput = curveInputs.red[imageData.data[index]];
      const greenOutput = curveInputs.green[imageData.data[index + 1]];
      const blueOutput = curveInputs.blue[imageData.data[index + 2]];
      histogram.red[redInput]++;
      histogram.green[greenInput]++;
      histogram.blue[blueInput]++;
      histogram.white[Math.round(redOutput * .2126 + greenOutput * .7152 + blueOutput * .0722)]++;
    }
    return histogram;
  }

  function updateProcessState() {
    const roll = activeRoll();
    roll.adjustments = normalizeAdjustments(roll.adjustments);
    roll.shots.forEach((shot) => {
      if (shot.adjustments) shot.adjustments = normalizeAdjustments(shot.adjustments);
    });
    roll.previewShotIndex = clamp(Number(roll.previewShotIndex) || 0, 0, Math.max(0, roll.shots.length - 1));
    const previewShot = roll.shots[roll.previewShotIndex] || null;
    $("#previewAdjustmentsToggle").disabled = !previewShot;
    $("#pickReferenceWhiteButton").disabled = !previewShot;
    $("#pickReferenceBlackButton").disabled = !previewShot;
    $("#previewAdjustmentsToggle").checked = Boolean(previewShot?.adjustments);
    $("#adjustmentScopeTitle").textContent = previewShot?.adjustments
      ? "Shot-specific image adjustments"
      : "Roll-wide image adjustments";
    const currentSettings = previewShot?.adjustments
      ? previewShot.adjustments
      : roll.adjustments;
    $("#desaturateToggle").checked = Boolean(currentSettings.desaturate);
    $("#gammaSelect").value = currentSettings.gamma;
    document.querySelectorAll("[data-adjustment-key]").forEach((input) => {
      input.value = currentSettings[input.dataset.adjustmentKey];
      const valueLabel = input.parentElement.querySelector("[data-adjustment-value]");
      valueLabel.textContent = `${input.value}${input.dataset.adjustmentKey === "contrast" ? "%" : input.dataset.adjustmentKey === "hue" ? "°" : ""}`;
    });
    drawCurveEditors();
    $("#processSummary").textContent = `${roll.shots.length} shot(s) in Roll ${roll.number}. Roll-wide adjustments apply to each shot unless that shot has its own settings.`;
  }
  function makePreviewKey(roll, shot) {
    return JSON.stringify([
      state.rollIndex,
      roll.previewShotIndex || 0,
      shot.number,
      shot.quad,
      shot.flipX,
      shot.flipY,
      $("#invertToggle").checked
    ]);
  }

  async function renderAdjustedPreview() {
    const image = state.previewBaseData;
    if (!image) return;
    const settings = getAdjustmentSettings();
    state.previewHistogram = histogramFor(image, $("#invertToggle").checked, settings);
    const output = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
    const sequence = (state.previewAdjustmentSequence || 0) + 1;
    state.previewAdjustmentSequence = sequence;
    await applyAdjustments(output.data, settings, $("#invertToggle").checked);
    if (sequence !== state.previewAdjustmentSequence || image !== state.previewBaseData) return;
    const canvas = $("#processPreview");
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext("2d").putImageData(output, 0, 0);
    drawCurveEditors();
  }

  function queueProcessPreview(rebuild = false) {
    clearTimeout(state.previewTimer);
    const roll = activeRoll();
    const shot = roll.shots[roll.previewShotIndex || 0];
    if (!rebuild && state.previewBaseData && (!shot || state.previewBaseKey !== makePreviewKey(roll, shot))) {
      rebuild = true;
    }
    if (rebuild) {
      state.previewBaseKey = "";
      state.previewBaseData = null;
      state.previewHistogram = null;
      previewPickBitmap?.close();
      previewPickBitmap = null;
    } else if (state.previewBaseData) {
      renderAdjustedPreview().catch((error) => notify(`Preview adjustment failed: ${error.message}`, true));
      return;
    } else if (state.previewProcessing) {
      state.previewPending = true;
      return;
    }
    state.previewTimer = setTimeout(updateProcessPreview, 120);
  }

  async function updateProcessPreview() {
    if (state.mode !== "process") return;
    const canvas = $("#processPreview");
    const roll = activeRoll();
    const shot = roll.shots[roll.previewShotIndex || 0];
    const sequence = (state.previewSequence || 0) + 1;
    state.previewSequence = sequence;
    if (!shot) {
      state.previewBaseKey = "";
      state.previewBaseData = null;
      state.previewHistogram = null;
      previewPickBitmap?.close();
      previewPickBitmap = null;
      drawCurveEditors();
      canvas.width = 900;
      canvas.height = 520;
      const context = canvas.getContext("2d");
      context.fillStyle = "#111412";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#909991";
      context.font = "16px sans-serif";
      context.textAlign = "center";
      context.fillText("Capture a frame to preview processing", canvas.width / 2, canvas.height / 2);
      return;
    }
    const previewKey = makePreviewKey(roll, shot);
    if (previewPickBitmap && state.previewBaseKey !== previewKey) {
      previewPickBitmap.close();
      previewPickBitmap = null;
    }
    if (state.previewBaseData && state.previewBaseKey === previewKey) {
      await renderAdjustedPreview();
      return;
    }
    if (state.previewProcessing) {
      state.previewPending = true;
      return;
    }
    state.previewProcessing = true;
    const progressId = beginProgress("Preparing image preview", `Processing Shot ${pad(shot.number)}…`, { blocking: false });
    try {
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      const blob = await processShot(shot, {
        raw: true,
        preview: true,
        onProgress: ({ stage, percent }) => updateProgress(progressId, stage, percent)
      });
      if (sequence !== state.previewSequence || state.mode !== "process" || previewKey !== makePreviewKey(activeRoll(), activeRoll().shots[activeRoll().previewShotIndex || 0] || shot)) return;
      const image = await createImageBitmap(blob);
      if (sequence !== state.previewSequence || state.mode !== "process" || previewKey !== makePreviewKey(activeRoll(), activeRoll().shots[activeRoll().previewShotIndex || 0] || shot)) {
        image.close();
        return;
      }
      const previewScale = Math.min(1, 1200 / image.width, 900 / image.height);
      const previewWidth = Math.max(1, Math.round(image.width * previewScale));
      const previewHeight = Math.max(1, Math.round(image.height * previewScale));
      canvas.width = previewWidth;
      canvas.height = previewHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0, previewWidth, previewHeight);
      state.previewBaseData = context.getImageData(0, 0, previewWidth, previewHeight);
      state.previewHistogram = histogramFor(
        state.previewBaseData,
        $("#invertToggle").checked,
        getAdjustmentSettings()
      );
      state.previewBaseKey = previewKey;
      previewPickBitmap?.close();
      previewPickBitmap = image;
      await renderAdjustedPreview();
    } catch (error) {
      updateProgress(progressId, `Preview failed: ${error.message}`, 100);
      const context = canvas.getContext("2d");
      canvas.width = 900;
      canvas.height = 140;
      context.fillStyle = "#111412";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#ffab9b";
      context.font = "14px sans-serif";
      context.fillText(`Preview unavailable: ${error.message}`, 16, 40);
    } finally {
      state.previewProcessing = false;
      if (state.previewPending) {
        state.previewPending = false;
        updateProcessPreview();
      } else endProgress(progressId);
    }
  }

  // Scans every reframed shot of the roll and keeps the per-channel min/max of the raw scan (with the shot it came from).
  async function scanRollLevels() {
    const roll = activeRoll();
    if (!roll.shots.length || !state.cvReady) return;
    const key = JSON.stringify(roll.shots.map((shot) => [shot.number, shot.quad, shot.flipX, shot.flipY]));
    if (roll.levelsKey === key && roll.levels) return;
    const progressId = beginProgress("Scanning roll levels", "Measuring min/max across all shots…", { blocking: false });
    try {
      const invert = $("#invertToggle").checked;
      const found = Object.fromEntries(rgbChannels.map((channel) => [channel, {
        min: 255, max: 0, minShot: null, maxShot: null
      }]));
      for (const [index, shot] of roll.shots.entries()) {
        updateProgress(progressId, `Scanning Shot ${pad(shot.number)} (${index + 1}/${roll.shots.length})`, index / roll.shots.length * 100);
        const blob = await processShot(shot, { raw: true, preview: true });
        const image = await createImageBitmap(blob);
        const scale = Math.min(1, 600 / image.width, 600 / image.height);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        image.close();
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        const histograms = rgbChannels.map(() => new Float64Array(256));
        for (let pixel = 0; pixel < data.length; pixel += 4) {
          histograms[0][data[pixel]]++;
          histograms[1][data[pixel + 1]]++;
          histograms[2][data[pixel + 2]]++;
        }
        const shotLevels = [];
        rgbChannels.forEach((channel, channelIndex) => {
          const histogram = histograms[channelIndex];
          const total = histogram.reduce((sum, count) => sum + count, 0);
          const limit = total * LEVELS_OUTLIER_FRACTION;
          let min = 0;
          let max = 255;
          for (let sum = 0; min < 255 && sum + histogram[min] <= limit; min++) sum += histogram[min];
          for (let sum = 0; max > 0 && sum + histogram[max] <= limit; max--) sum += histogram[max];
          if (min < found[channel].min) Object.assign(found[channel], { min, minShot: shot.number });
          if (max > found[channel].max) Object.assign(found[channel], { max, maxShot: shot.number });
          shotLevels.push(`${channel} ${min}-${max}`);
        });
        console.log(`[Levels] Shot ${pad(shot.number)} raw scan min-max: ${shotLevels.join(", ")}`);
      }
      const levels = {};
      rgbChannels.forEach((channel) => {
        const { min, max } = found[channel];
        levels[channel] = { min, max: Math.max(max, min + 1) };
        const range = workingRange(levels[channel], invert);
        const lowShot = invert ? found[channel].maxShot : found[channel].minShot;
        const highShot = invert ? found[channel].minShot : found[channel].maxShot;
        console.log(`[Levels] Roll ${pad(roll.number)} ${channel}: min ${range.min} (Shot ${pad(lowShot)}), max ${range.max} (Shot ${pad(highShot)}) after ${invert ? "inversion" : "no inversion"}; raw scan ${min}-${max}`);
      });
      roll.levels = levels;
      roll.levelsKey = key;
      roll.adjustments = normalizeAdjustments(roll.adjustments);
      roll.adjustments.levels = cloneLevels(levels);
      updateProgress(progressId, "Roll levels ready", 100);
    } catch (error) {
      notify(`Roll level scan failed: ${error.message}`, true);
    } finally {
      endProgress(progressId);
    }
  }

  function buildAdjustmentControls() {
    const container = $("#processAdjustments");
    const sliders = adjustmentOptions.map(([key, label, min, max, step]) =>
      `<label class="block py-3 text-xs">${label} <span class="badge ml-2" data-adjustment-value></span>` +
      `<input class="mt-2 w-full" type="range" min="${min}" max="${max}" step="${step}" value="${defaultAdjustments()[key]}" data-adjustment-key="${key}" aria-label="${label}"></label>`
    ).join("");
    container.innerHTML = `<div id="processCurveEditors"></div><div class="adjustment-sliders">${sliders}</div>`;
    createCurveEditors(
      $("#processCurveEditors"),
      "process",
      getAdjustmentSettings,
      () => queueProcessPreview()
    );
    container.addEventListener("change", (event) => {
      const input = event.target.closest("[data-level-channel]");
      if (!input) return;
      const channel = input.dataset.levelChannel;
      const field = (bound) => container.querySelector(`[data-level-channel="${channel}"][data-level-bound="${bound}"]`);
      const low = clamp(Math.round(Number(field("min").value) || 0), 0, 254);
      const high = clamp(Math.round(Number(field("max").value) || 255), low + 1, 255);
      activeAdjustmentSettings().levels[channel] = $("#invertToggle").checked
        ? { min: 255 - high, max: 255 - low }
        : { min: low, max: high };
      updateProcessState();
      queueProcessPreview();
    });
    container.addEventListener("input", (event) => {
      const input = event.target.closest("[data-adjustment-key]");
      if (!input) return;
      const settings = activeAdjustmentSettings();
      settings[input.dataset.adjustmentKey] = Number(input.value);
      const valueLabel = input.parentElement.querySelector("[data-adjustment-value]");
      valueLabel.textContent = `${input.value}${input.dataset.adjustmentKey === "contrast" ? "%" : input.dataset.adjustmentKey === "hue" ? "°" : ""}`;
      queueProcessPreview();
    });
  }
  buildAdjustmentControls();
  let previewPickBitmap = null;
  let referencePickMode = null;
  const referencePickButtons = {
    white: $("#pickReferenceWhiteButton"),
    black: $("#pickReferenceBlackButton")
  };
  function setReferencePickMode(mode) {
    referencePickMode = referencePickMode === mode ? null : mode;
    Object.entries(referencePickButtons).forEach(([name, button]) => {
      button.setAttribute("aria-pressed", String(referencePickMode === name));
    });
    $("#processPreview").classList.toggle("reference-pick-active", Boolean(referencePickMode));
  }
  Object.entries(referencePickButtons).forEach(([mode, button]) => {
    button.addEventListener("click", () => setReferencePickMode(mode));
  });
  $("#processPreview").addEventListener("click", (event) => {
    if (!referencePickMode) return;
    if (!previewPickBitmap) {
      notify("Wait for the cropped preview to finish loading before picking a reference pixel.", true);
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = clamp(Math.floor((event.clientX - bounds.left) / bounds.width * previewPickBitmap.width), 0, previewPickBitmap.width - 1);
    const y = clamp(Math.floor((event.clientY - bounds.top) / bounds.height * previewPickBitmap.height), 0, previewPickBitmap.height - 1);
    const pixelCanvas = document.createElement("canvas");
    pixelCanvas.width = 1;
    pixelCanvas.height = 1;
    const pixelContext = pixelCanvas.getContext("2d", { willReadFrequently: true });
    pixelContext.drawImage(previewPickBitmap, x, y, 1, 1, 0, 0, 1, 1);
    const pixel = pixelContext.getImageData(0, 0, 1, 1).data;
    const settings = activeAdjustmentSettings();
    const invert = $("#invertToggle").checked;
    rgbChannels.forEach((channel, index) => {
      const sample = pixel[index];
      const whiteEndpoint = referencePickMode === "white";
      const rawBound = whiteEndpoint === invert ? "min" : "max";
      const range = settings.levels[channel];
      if (rawBound === "min") {
        range.min = clamp(sample, 0, 254);
        range.max = Math.max(range.max, range.min + 1);
      } else {
        range.max = clamp(sample, 1, 255);
        range.min = Math.min(range.min, range.max - 1);
      }
    });
    const pickedMode = referencePickMode;
    setReferencePickMode(null);
    updateProcessState();
    queueProcessPreview();
    notify(`Reference ${pickedMode} set from RGB ${pixel[0]}, ${pixel[1]}, ${pixel[2]}.`);
  });
  createCurveEditors(
    $("#captureCurves"),
    "capture",
    () => state.livePreviewAdjustments,
    updateCapturePreviewFilter
  );
  createCurveEditors(
    $("#reviewCurves"),
    "review",
    () => state.livePreviewAdjustments,
    updateCapturePreviewFilter
  );
  drawCurveEditors();
  function selectProcessShot(index) {
    const roll = activeRoll();
    if (!roll.shots.length) return;
    const count = roll.shots.length;
    state.selectedShotIndex = ((index % count) + count) % count;
    roll.previewShotIndex = state.selectedShotIndex;
    renderFilmList();
    updateProcessState();
    queueProcessPreview(true);
  }
  $("#previewAdjustmentsToggle").addEventListener("change", () => {
    const roll = activeRoll();
    const shot = roll.shots[roll.previewShotIndex || 0];
    if (!shot) return;
    shot.adjustments = $("#previewAdjustmentsToggle").checked ? normalizeAdjustments(roll.adjustments) : null;
    updateProcessState();
    queueProcessPreview();
  });
  $("#desaturateToggle").addEventListener("change", (event) => {
    activeAdjustmentSettings().desaturate = event.target.checked;
    updateProcessState();
    queueProcessPreview();
  });
  $("#gammaSelect").addEventListener("change", (event) => {
    activeAdjustmentSettings().gamma = event.target.value;
    queueProcessPreview();
  });
  ["invertToggle", "zlog2Toggle"].forEach((id) => {
    $("#" + id).addEventListener("change", () => {
      updateProcessState();
      queueProcessPreview(true);
    });
  });

  const PROFILE_FORMAT = "NegativeLabColorProfile";

  function profileFromSettings(settings) {
    const normalized = normalizeAdjustments(settings);
    return {
      format: PROFILE_FORMAT,
      version: 1,
      mode: normalized.mode,
      desaturate: normalized.desaturate,
      gamma: normalized.gamma,
      brightness: normalized.brightness,
      contrast: normalized.contrast,
      hue: normalized.hue,
      tint: normalized.tint,
      levels: normalized.levels,
      curves: normalized.curves
    };
  }

  function settingsFromProfileText(text) {
    let profile;
    try { profile = JSON.parse(text); }
    catch (error) { throw new Error("This file is not a valid color profile."); }
    if (profile?.format !== PROFILE_FORMAT) throw new Error("This file is not a Negative Lab color profile.");
    const number = (value, fallback, min, max) => Number.isFinite(Number(value)) ? clamp(Number(value), min, max) : fallback;
    const curvePoints = (points, fallback) => {
      if (!Array.isArray(points) || points.length < 2) return fallback;
      const valid = points
        .map((point) => ({ x: Number(point?.x), y: Number(point?.y) }))
        .filter(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))
        .map(({ x, y }) => ({ x: clamp(x, 0, 1), y: clamp(y, 0, 1) }))
        .sort((first, second) => first.x - second.x);
      return valid.length >= 2 ? valid : fallback;
    };
    const mode = profile.mode === "bw" ? "bw" : "color";
    const desaturate = typeof profile.desaturate === "boolean" ? profile.desaturate : mode === "bw";
    const defaults = defaultAdjustments(mode);
    const levels = cloneLevels(profile.levels);
    rgbChannels.forEach((channel) => {
      levels[channel].min = clamp(levels[channel].min, 0, 255);
      levels[channel].max = clamp(levels[channel].max, 0, 255);
    });
    return {
      mode,
      desaturate,
      gamma: ["srgb", "2.2", "off"].includes(profile.gamma) ? profile.gamma : defaults.gamma,
      brightness: number(profile.brightness, 0, -100, 100),
      contrast: number(profile.contrast, 100, 0, 200),
      hue: number(profile.hue, 0, -180, 180),
      tint: number(profile.tint, 0, -100, 100),
      curvePresetVersion: 4,
      levels,
      curves: Object.fromEntries(curveChannels.map((channel) => [channel, curvePoints(profile.curves?.[channel], defaults.curves[channel])]))
    };
  }

  function saveColorProfile(scope) {
    const settings = scope === "process" ? getAdjustmentSettings() : state.livePreviewAdjustments;
    const blob = new Blob([JSON.stringify(profileFromSettings(settings), null, 2)], { type: "text/plain" });
    downloadBlob(blob, `NegativeLab_color_profile_${new Date().toISOString().slice(0, 10)}.txt`);
    notify("Color profile saved.");
  }

  function applyColorProfile(scope, loaded) {
    if (scope === "process") {
      Object.assign(getAdjustmentSettings(), loaded);
      updateProcessState();
      queueProcessPreview();
    } else {
      Object.assign(state.livePreviewAdjustments, loaded);
      state.livePreviewAdjustments.mode = loaded.desaturate ? "bw" : "color";
      $("#captureBrightness").value = loaded.brightness;
      $("#captureContrast").value = loaded.contrast;
      $("#captureHue").value = loaded.hue;
      $("#capturePreviewMode").value = state.livePreviewAdjustments.mode;
      $("#reviewPreviewMode").value = state.livePreviewAdjustments.mode;
      updateCapturePreviewFilter();
      drawCurveEditors();
    }
  }

  let pendingProfileScope = "live";
  document.querySelectorAll("[data-profile-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const scope = button.dataset.profileScope;
      if (button.dataset.profileAction === "save") { saveColorProfile(scope); return; }
      pendingProfileScope = scope;
      $("#loadProfileInput").click();
    });
  });
  $("#loadProfileInput").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      applyColorProfile(pendingProfileScope, settingsFromProfileText(await file.text()));
      notify("Color profile loaded.");
    } catch (error) {
      notify(error.message, true);
    }
  });

  let openCVUnavailable = false;
  function initializeOpenCV() {
    if (openCVUnavailable) return;
    if (typeof cv === "undefined") { setTimeout(initializeOpenCV, 250); return; }
    if (cv.Mat) { onOpenCVReady(); return; }
    cv.onRuntimeInitialized = onOpenCVReady;
  }
  const openCVReady = window.NegativeLabDependencies?.openCVReady;
  if (openCVReady) openCVReady.then((available) => {
    if (available || state.cvReady) return;
    openCVUnavailable = true;
    $("#cvStatus").textContent = "OpenCV unavailable";
    $("#captureStatus").textContent = "Image processing is unavailable; check the dependency warning.";
    notify("OpenCV.js could not load from the CDN or local fallback.", true);
  });
  else {
    openCVUnavailable = true;
    $("#cvStatus").textContent = "Dependency loader unavailable";
    notify("The CDN dependency loader could not start.", true);
  }
  function onOpenCVReady() {
    if (state.cvReady) return;
    state.cvReady = true;
    $("#cvStatus").textContent = "OpenCV ready";
    $("#cvStatus").classList.add("ready");
    if (state.stream) $("#captureStatus").textContent = "Camera and image processing ready.";
  }
  initializeOpenCV();
  requestAnimationFrame(capturePreviewLoop);
  updateBurstFrameCountDisplay();
  updateCounts();
})();
