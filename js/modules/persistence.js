(() => {
  "use strict";

  const DB_NAME = "negative-lab";
  const DB_VERSION = 1;
  const SESSION_KEY = "current";
  const SESSION_VERSION = 1;
  const AUTOSAVE_INTERVAL_MS = 2000;
  const DIRECTORY_KEY = "saveFolder";
  const SESSION_FILE = "session.json";
  const SHOTS_DIR = "shots";
  const BACKUPS_DIR = "backups";
  const BACKUP_INTERVAL_MS = 60 * 1000;
  const BACKUPS_TO_KEEP = 12;
  const BACKUP_PATTERN = /^session-.*\.json$/;
  const supportsFolders = typeof window.showDirectoryPicker === "function";

  // Backends: a user-chosen save folder (session.json plus shots/<id>.rgba) or IndexedDB as fallback.
  // Pixels are never edited after capture, so each buffer is written once and deleted when its shot is removed.
  window.NegativeLabPersistence = function createPersistence({ notify }) {
    let databasePromise = null;
    const storedPixelIds = new Set();
    let lastSavedJson = null;
    let chain = Promise.resolve();
    let saveQueued = false;
    let saveFailureReported = false;
    let lastBackupAt = 0;
    let buildSession = null;
    let storedHandle = null;
    let folder = null;
    let active = null;
    const connectButton = document.querySelector("#saveFolderButton");
    const folderOverlay = document.querySelector("#folderOverlay");
    const reconnectButton = document.querySelector("#reconnectFolderButton");
    const browserButton = document.querySelector("#useBrowserStorageButton");

    function openDatabase() {
      databasePromise ||= new Promise((resolve, reject) => {
        if (!window.indexedDB) {
          reject(new Error("IndexedDB is not available in this browser."));
          return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          request.result.createObjectStore("shots", { keyPath: "id" });
          request.result.createObjectStore("session");
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }).catch((error) => {
        databasePromise = null;
        throw error;
      });
      return databasePromise;
    }

    function requestResult(request) {
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    function transactionDone(transaction) {
      return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error("Storage transaction was aborted."));
      });
    }

    function createId() {
      return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

    function reportFailure(error) {
      console.error("Session could not be saved", error);
      if (saveFailureReported) return;
      saveFailureReported = true;
      const message = {
        NotAllowedError: "Save folder access was lost. Reload the page and reconnect the folder.",
        InvalidStateError: "The save folder changed while saving. Close other tabs of this page or programs using the folder, then reload."
      }[error.name] || "This session could not be saved. Export your work to keep it.";
      notify(message, true);
    }

    // Writes run one at a time, in order, so a folder switch can't interleave with an autosave.
    function enqueue(task) {
      chain = chain.then(task);
      return chain;
    }

    function saveNow() {
      if (saveQueued) return chain;
      saveQueued = true;
      return enqueue(async () => {
        saveQueued = false;
        await writeChanges();
      });
    }

    async function writeChanges() {
      if (!buildSession || !active) return;
      try {
        const session = buildSession();
        const shots = session.rolls.flatMap((roll) => roll.shots);
        shots.forEach((shot) => {
          shot.id ||= createId();
        });
        const record = toRecord(session);
        const json = JSON.stringify(record);
        if (json === lastSavedJson) return;

        const liveIds = new Set(shots.map((shot) => shot.id));
        const newShots = shots.filter((shot) => !storedPixelIds.has(shot.id));
        const removedIds = [...storedPixelIds].filter((id) => !liveIds.has(id));
        await active.write({ newShots, removedIds, record });

        newShots.forEach((shot) => storedPixelIds.add(shot.id));
        removedIds.forEach((id) => storedPixelIds.delete(id));
        lastSavedJson = json;
        saveFailureReported = false;
      } catch (error) {
        reportFailure(error);
      }
    }

    function toRecord(session) {
      return {
        ...session,
        version: SESSION_VERSION,
        rolls: session.rolls.map((roll) => ({
          ...roll,
          shots: roll.shots.map(({ pixels, ...metadata }) => metadata)
        }))
      };
    }

    function isValidRecord(record) {
      return record?.version === SESSION_VERSION && Array.isArray(record.rolls);
    }

    function shotFileName(id) {
      return `${id}.rgba`;
    }

    function missingAsNull(error) {
      if (error.name === "NotFoundError") return null;
      throw error;
    }

    function fileStamp() {
      return new Date().toISOString().replace(/[:.]/g, "-");
    }

    function parseRecord(text) {
      try {
        const record = JSON.parse(text);
        return isValidRecord(record) ? record : null;
      } catch (error) {
        return null;
      }
    }

    async function listBackupNames(backupsDir) {
      const names = [];
      for await (const entry of backupsDir.values()) {
        if (entry.kind === "file" && BACKUP_PATTERN.test(entry.name)) names.push(entry.name);
      }
      return names.sort();
    }

    async function readNewestBackup() {
      const backupsDir = await folder.getDirectoryHandle(BACKUPS_DIR).catch(missingAsNull);
      if (!backupsDir) return null;
      for (const name of (await listBackupNames(backupsDir)).reverse()) {
        const record = parseRecord(await (await (await backupsDir.getFileHandle(name)).getFile()).text());
        if (record) return { name, record };
      }
      return null;
    }

    // Snapshots session.json into backups/ at most once per interval; failures never block autosave.
    async function backupIfDue(json) {
      if (Date.now() - lastBackupAt < BACKUP_INTERVAL_MS) return;
      try {
        const backupsDir = await folder.getDirectoryHandle(BACKUPS_DIR, { create: true });
        await writeFile(backupsDir, `session-${fileStamp()}.json`, json);
        lastBackupAt = Date.now();
        const names = await listBackupNames(backupsDir);
        for (const name of names.slice(0, -BACKUPS_TO_KEEP)) await backupsDir.removeEntry(name).catch(missingAsNull);
      } catch (error) {
        console.warn("Periodic session backup failed", error);
      }
    }

    // Fresh handles on each attempt, since a handle cached before an external change keeps failing.
    async function writeFile(directory, name, data) {
      for (let attempt = 1; ; attempt++) {
        try {
          const file = await directory.getFileHandle(name, { create: true });
          const writable = await file.createWritable();
          try {
            await writable.write(data);
            await writable.close();
            return;
          } catch (error) {
            await writable.abort().catch(() => {});
            throw error;
          }
        } catch (error) {
          if (error.name !== "InvalidStateError" || attempt >= 3) throw error;
          await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
        }
      }
    }

    const browserBackend = {
      async read() {
        const database = await openDatabase();
        const transaction = database.transaction(["shots", "session"], "readonly");
        const record = await requestResult(transaction.objectStore("session").get(SESSION_KEY));
        return isValidRecord(record) ? { record } : null;
      },
      async readPixels(ids) {
        const database = await openDatabase();
        const transaction = database.transaction("shots", "readonly");
        const records = await Promise.all(ids.map((id) => requestResult(transaction.objectStore("shots").get(id))));
        return new Map(records.filter(Boolean).map((shot) => [shot.id, shot.pixels]));
      },
      async write({ newShots, removedIds, record }) {
        const database = await openDatabase();
        const transaction = database.transaction(["shots", "session"], "readwrite");
        try {
          const shotStore = transaction.objectStore("shots");
          newShots.forEach((shot) => shotStore.put({ id: shot.id, width: shot.width, height: shot.height, pixels: shot.pixels }));
          removedIds.forEach((id) => shotStore.delete(id));
          transaction.objectStore("session").put(record, SESSION_KEY);
          await transactionDone(transaction);
        } catch (error) {
          try { transaction.abort(); } catch (abortError) { /* already finished */ }
          throw error;
        }
      }
    };

    // Browsers commit each file on close, so a crash mid-write keeps the previous version.
    const folderBackend = {
      async read() {
        const sessionFile = await folder.getFileHandle(SESSION_FILE).catch(missingAsNull);
        let record = null;
        if (sessionFile) {
          const text = await (await sessionFile.getFile()).text();
          record = parseRecord(text);
          if (!record) {
            // Keep the unreadable copy so autosave can't overwrite it.
            const backupsDir = await folder.getDirectoryHandle(BACKUPS_DIR, { create: true });
            await writeFile(backupsDir, `unreadable-${fileStamp()}.json`, text);
          }
        }
        if (!record) {
          const backup = await readNewestBackup();
          if (backup) {
            record = backup.record;
            notify(`session.json could not be read, so the session was restored from backups/${backup.name}.`, true);
          }
        }
        if (!record) return null;
        return { record };
      },
      async readPixels(ids) {
        const shotsDir = await folder.getDirectoryHandle(SHOTS_DIR).catch(missingAsNull);
        const pixelsById = new Map();
        for (const id of ids) {
          const file = await shotsDir?.getFileHandle(shotFileName(id)).catch(missingAsNull);
          if (file) pixelsById.set(id, new Uint8ClampedArray(await (await file.getFile()).arrayBuffer()));
        }
        return pixelsById;
      },
      async write({ newShots, removedIds, record }) {
        const shotsDir = await folder.getDirectoryHandle(SHOTS_DIR, { create: true });
        for (const shot of newShots) await writeFile(shotsDir, shotFileName(shot.id), shot.pixels);
        const json = JSON.stringify(record);
        await writeFile(folder, SESSION_FILE, json);
        await backupIfDue(json);
        for (const id of removedIds) await shotsDir.removeEntry(shotFileName(id)).catch(missingAsNull);
      }
    };

    async function saveFolderHandle(handle) {
      const database = await openDatabase();
      const transaction = database.transaction("session", "readwrite");
      transaction.objectStore("session").put(handle, DIRECTORY_KEY);
      await transactionDone(transaction);
    }

    async function loadFolderHandle() {
      if (!supportsFolders) return null;
      const database = await openDatabase();
      const transaction = database.transaction("session", "readonly");
      return (await requestResult(transaction.objectStore("session").get(DIRECTORY_KEY))) || null;
    }

    async function hasAccess(handle) {
      return (await handle.queryPermission({ mode: "readwrite" })) === "granted";
    }

    function askToReconnect(handle) {
      return new Promise((resolve) => {
        folderOverlay.hidden = false;
        const finish = (granted) => {
          folderOverlay.hidden = true;
          if (!granted) notify("Save folder access was not granted, so captures are saved in browser storage.", true);
          resolve(granted);
        };
        reconnectButton.addEventListener("click", async () => {
          finish((await handle.requestPermission({ mode: "readwrite" }).catch(() => "denied")) === "granted");
        }, { once: true });
        browserButton.addEventListener("click", () => finish(false), { once: true });
      });
    }

    async function readSession(backend) {
      const stored = await backend.read();
      storedPixelIds.clear();
      lastSavedJson = null;
      if (!stored) return null;
      const rollIndex = Number.isInteger(stored.record.rollIndex)
        ? Math.max(0, Math.min(stored.record.rollIndex, stored.record.rolls.length - 1))
        : 0;
      const pixelsById = await backend.readPixels(stored.record.rolls[rollIndex]?.shots.map(({ id }) => id) || []);
      let missingCount = 0;
      const rolls = stored.record.rolls.map((roll, index) => ({
        ...roll,
        shots: roll.shots.flatMap((metadata) => {
          storedPixelIds.add(metadata.id);
          const pixels = index === rollIndex ? pixelsById.get(metadata.id) : null;
          if (index === rollIndex && !pixels) {
            missingCount++;
            return [];
          }
          return [{ ...metadata, pixels }];
        })
      }));
      if (missingCount) console.warn(`${missingCount} saved frame(s) had no image data and were skipped.`);
      return { ...stored.record, rolls };
    }

    async function loadRoll(session, rollIndex) {
      const roll = session.rolls[rollIndex];
      if (!roll) return;
      const pixelsById = await active.readPixels(roll.shots.map(({ id }) => id));
      let missingCount = 0;
      roll.shots = roll.shots.flatMap((shot) => {
        const pixels = pixelsById.get(shot.id);
        if (!pixels) {
          missingCount++;
          return [];
        }
        storedPixelIds.add(shot.id);
        return [{ ...shot, pixels }];
      });
      if (missingCount) console.warn(`${missingCount} saved frame(s) had no image data and were skipped.`);
    }

    function updateFolderButton() {
      connectButton.hidden = !supportsFolders;
      if (active === folderBackend) connectButton.textContent = `Save folder: ${folder.name}`;
      else connectButton.textContent = storedHandle ? "Reconnect save folder" : "Choose save folder";
    }

    async function useFolder(handle) {
      await saveFolderHandle(handle);
      storedHandle = handle;
      await enqueue(async () => {
        folder = handle;
        active = folderBackend;
        storedPixelIds.clear();
        lastSavedJson = null;
        await writeChanges();
      });
      updateFolderButton();
      notify(`Saving captures to the folder "${handle.name}".`);
    }

    async function onConnectClick() {
      try {
        const reconnected = active !== folderBackend && storedHandle && (await storedHandle.requestPermission({ mode: "readwrite" })) === "granted";
        await useFolder(reconnected ? storedHandle : await window.showDirectoryPicker({ mode: "readwrite" }));
      } catch (error) {
        if (error.name !== "AbortError") notify(`The save folder could not be used: ${error.message}`, true);
      }
    }

    async function load() {
      navigator.storage?.persist?.().catch(() => {});
      connectButton.disabled = true;
      try {
        storedHandle = await loadFolderHandle().catch(() => null);
        const useFolderStore = storedHandle && ((await hasAccess(storedHandle)) || (await askToReconnect(storedHandle)));
        if (useFolderStore) folder = storedHandle;
        active = useFolderStore ? folderBackend : browserBackend;
        updateFolderButton();
        return await readSession(active);
      } finally {
        connectButton.disabled = false;
      }
    }

    function startAutosave(getSession) {
      buildSession = getSession;
      setInterval(saveNow, AUTOSAVE_INTERVAL_MS);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") saveNow();
      });
      window.addEventListener("pagehide", saveNow);
    }

    connectButton.addEventListener("click", onConnectClick);

    return { load, loadRoll, startAutosave, saveNow };
  };
})();
