(() => {
  "use strict";

  window.NegativeLabExport = function createExporter({ state, $, pad, notify, beginProgress, updateProgress, endProgress, processShot }) {
    const encoder = new TextEncoder();
    const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      return value >>> 0;
    });

    function updateExportState() {
      const shots = state.rolls.reduce((total, roll) => total + roll.shots.length, 0);
      $("#exportStatus").textContent = `${shots} frame(s) across ${state.rolls.filter((roll) => roll.shots.length).length} roll(s) ready to export.`;
    }

    function safeName(value) {
      return String(value).trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").slice(0, 80) || "Roll";
    }

    function crc32(bytes) {
      let crc = 0xffffffff;
      for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
      return (crc ^ 0xffffffff) >>> 0;
    }

    async function createZip(files) {
      if (files.length > 0xffff) throw new Error("This export contains too many files for a standard ZIP archive.");
      const localParts = [];
      const centralParts = [];
      let offset = 0;
      for (const file of files) {
        const name = encoder.encode(file.name);
        const size = file.blob.size;
        if (size > 0xffffffff || offset + size > 0xffffffff) {
          throw new Error("This export is too large for a standard ZIP archive (4 GB limit).");
        }
        // Hash transiently; the Blob itself is kept in the archive so no full copy stays resident.
        const checksum = crc32(new Uint8Array(await file.blob.arrayBuffer()));
        const local = new Uint8Array(30 + name.length);
        const localView = new DataView(local.buffer);
        localView.setUint32(0, 0x04034b50, true);
        localView.setUint16(4, 20, true);
        localView.setUint16(6, 0x0800, true);
        localView.setUint16(10, 0, true);
        localView.setUint16(12, 0x21, true);
        localView.setUint32(14, checksum, true);
        localView.setUint32(18, size, true);
        localView.setUint32(22, size, true);
        localView.setUint16(26, name.length, true);
        local.set(name, 30);
        localParts.push(local, file.blob);

        const central = new Uint8Array(46 + name.length);
        const centralView = new DataView(central.buffer);
        centralView.setUint32(0, 0x02014b50, true);
        centralView.setUint16(4, 20, true);
        centralView.setUint16(6, 20, true);
        centralView.setUint16(8, 0x0800, true);
        centralView.setUint16(12, 0, true);
        centralView.setUint16(14, 0x21, true);
        centralView.setUint32(16, checksum, true);
        centralView.setUint32(20, size, true);
        centralView.setUint32(24, size, true);
        centralView.setUint16(28, name.length, true);
        centralView.setUint32(42, offset, true);
        central.set(name, 46);
        centralParts.push(central);
        offset += local.byteLength + size;
        if (offset > 0xffffffff) throw new Error("This export is too large for a standard ZIP archive (4 GB limit).");
      }
      const centralSize = centralParts.reduce((size, part) => size + part.byteLength, 0);
      const end = new Uint8Array(22);
      const endView = new DataView(end.buffer);
      endView.setUint32(0, 0x06054b50, true);
      endView.setUint16(8, files.length, true);
      endView.setUint16(10, files.length, true);
      endView.setUint32(12, centralSize, true);
      endView.setUint32(16, offset, true);
      return new Blob([...localParts, ...centralParts, end], { type: "application/zip" });
    }

    function downloadBlob(blob, name) {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    async function exportRoll(asZip = false) {
      const rolls = state.rolls.filter((roll) => roll.shots.length);
      const totalShots = rolls.reduce((total, roll) => total + roll.shots.length, 0);
      if (!totalShots) { notify("There are no captured frames to export.", true); return; }
      const includeRaw = $("#rawExportToggle").getAttribute("aria-pressed") === "true";
      const totalFiles = totalShots * (includeRaw ? 2 : 1);
      const exportButton = $("#exportButton");
      const zipButton = $("#exportZipButton");
      const progress = $("#exportProgress");
      const fill = $("#exportProgressFill");
      exportButton.disabled = true;
      zipButton.disabled = true;
      progress.classList.remove("hidden");
      const files = [];
      let progressId = null;
      try {
        let directory = null;
        if (!asZip && "showDirectoryPicker" in window) {
          try { directory = await window.showDirectoryPicker({ mode: "readwrite" }); }
          catch (error) {
            if (error.name === "AbortError") { $("#exportStatus").textContent = "Folder selection cancelled."; return; }
            throw error;
          }
        }
        progressId = beginProgress(asZip ? "Creating ZIP archive" : "Exporting individual PNGs", `Preparing ${totalFiles} image(s) for export…`);
        await new Promise((resolve) => setTimeout(resolve, 0));
        let completed = 0;
        for (const roll of rolls) {
          const rollFolder = `${pad(roll.number)}_${safeName(roll.name || `Roll ${pad(roll.number)}`)}`;
          const rollDirectory = directory ? await directory.getDirectoryHandle(rollFolder, { create: true }) : null;
          for (const shot of roll.shots) {
            const variants = [{ raw: false, prefix: "" }];
            if (includeRaw) variants.push({ raw: true, prefix: "_neg_" });
            for (const { raw, prefix } of variants) {
              const label = raw ? "Raw negative" : "Processed positive";
              updateProgress(progressId, `${label} · Roll ${pad(roll.number)} · Shot ${pad(shot.number)}`, completed / totalFiles * 100);
              const blob = await processShot(shot, {
                raw,
                adjustments: raw ? null : (shot.adjustments || roll.adjustments),
                onProgress: ({ stage, percent }) => {
                  const overallPercent = (completed + percent / 100) / totalFiles * 100;
                  updateProgress(progressId, `${label} · Roll ${pad(roll.number)} · Shot ${pad(shot.number)} · ${stage}`, overallPercent);
                }
              });
              const name = `${prefix}Shot_${pad(shot.number)}.png`;
              if (asZip) files.push({ name: `${rollFolder}/${raw ? "negatives/" : ""}${name}`, blob });
              else if (rollDirectory) {
                const handle = await rollDirectory.getFileHandle(name, { create: true });
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
              } else files.push({ name: `${rollFolder}_${name}`, blob });
              completed++;
              fill.style.width = `${Math.round(completed / totalFiles * 100)}%`;
              $("#exportStatus").textContent = `Exported ${completed} of ${totalFiles} images…`;
              updateProgress(progressId, `Saved ${completed} of ${totalFiles} image(s)`, completed / totalFiles * 100);
            }
          }
        }
        if (asZip) {
          const zip = await createZip(files);
          const archiveName = `${safeName(rolls.length === 1 ? rolls[0].name || `Roll ${pad(rolls[0].number)}` : "NegativeLab_Export")}.zip`;
          downloadBlob(zip, archiveName);
          $("#exportStatus").textContent = `Exported ${files.length} PNG(s) across ${rolls.length} roll(s) in ${archiveName}.`;
        } else if (!directory) {
          for (const file of files) {
            downloadBlob(file.blob, file.name);
            await new Promise((resolve) => setTimeout(resolve, 220));
          }
          $("#exportStatus").textContent = `Exported ${files.length} PNG(s) across ${rolls.length} roll(s) as browser downloads.`;
        } else $("#exportStatus").textContent = `Saved ${totalFiles} PNG(s) in ${rolls.length} roll folder(s).`;
        updateProgress(progressId, "All roll exports complete", 100);
        notify(asZip ? "ZIP export complete." : "All roll exports complete.");
      } catch (error) {
        console.error("Export failed", error);
        $("#exportStatus").textContent = `Export stopped: ${error.message}`;
        notify(`Export failed: ${error.message}`, true);
      } finally {
        if (progressId !== null) endProgress(progressId);
        exportButton.disabled = false;
        zipButton.disabled = false;
        setTimeout(() => progress.classList.add("hidden"), 1200);
      }
    }

    $("#exportButton").addEventListener("click", () => exportRoll(false));
    $("#exportZipButton").addEventListener("click", () => exportRoll(true));
    $("#rawExportToggle").addEventListener("click", () => {
      const toggle = $("#rawExportToggle");
      const includeRaw = toggle.getAttribute("aria-pressed") !== "true";
      toggle.setAttribute("aria-pressed", String(includeRaw));
      $("#exportStatus").textContent = includeRaw
        ? "Processed positives and raw negatives will be exported."
        : "Processed positives will be exported.";
    });

    return { updateExportState, exportRoll };
  };
})();
