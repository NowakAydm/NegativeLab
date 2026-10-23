(() => {
  "use strict";

  const state = {
    rolls: [{ number: 1, shots: [] }],
    rollIndex: 0,
    selectedShotIndex: 0,
    mode: "setup",
    stream: null,
    cvReady: false,
    burstFrameCount: 1,
    capturing: false,
    cropDisplay: null,
    previewTimer: null,
    drag: null,
    toastTimer: null,
    audioContext: null,
    previewProcessing: false,
    previewPending: false,
    previewSequence: 0
  };

  const $ = (selector) => document.querySelector(selector);
  const activeRoll = () => state.rolls[state.rollIndex];
  const activeShot = () => activeRoll()?.shots[state.selectedShotIndex] || null;
  const pad = (value) => String(value).padStart(2, "0");
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  let progressOperationId = 0;
  let activeProgressOperationId = 0;
  let activeProgressIsBlocking = true;

  function notify(message, isError = false) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.toggle("error", isError);
    toast.classList.remove("hidden");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.add("hidden"), 4200);
  }

  function beginProgress(title, message, { blocking = true } = {}) {
    const id = ++progressOperationId;
    activeProgressOperationId = id;
    const dialog = $("#progressDialog");
    if (dialog.open && activeProgressIsBlocking !== blocking) dialog.close();
    activeProgressIsBlocking = blocking;
    $("#progressTitle").textContent = title;
    $("#progressMessage").textContent = message;
    $("#progressMeter").value = 0;
    $("#progressPercent").textContent = "0%";
    dialog.toggleAttribute("data-nonblocking", !blocking);
    dialog.setAttribute("aria-modal", String(blocking));
    if (!dialog.open) {
      if (blocking) dialog.showModal();
      else dialog.show();
    }
    return id;
  }

  function updateProgress(id, message, percent) {
    if (id !== activeProgressOperationId) return;
    $("#progressMessage").textContent = message;
    $("#progressMeter").value = clamp(percent, 0, 100);
    $("#progressPercent").textContent = `${Math.round(clamp(percent, 0, 100))}%`;
  }

  function endProgress(id) {
    if (id !== activeProgressOperationId) return;
    activeProgressOperationId = 0;
    activeProgressIsBlocking = true;
    const dialog = $("#progressDialog");
    if (dialog.open) dialog.close();
  }

  $("#progressDialog").addEventListener("cancel", (event) => event.preventDefault());

  window.NegativeLabCore = { state, $, activeRoll, activeShot, pad, clamp, notify, beginProgress, updateProgress, endProgress };
})();
