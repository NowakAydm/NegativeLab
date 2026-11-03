(() => {
  "use strict";

  const DB_NAME = "negative-lab";
  const DB_VERSION = 1;
  const SESSION_KEY = "current";
  const SESSION_VERSION = 1;
  const AUTOSAVE_INTERVAL_MS = 2000;

  // Session metadata lives in the "session" store; shot pixel buffers live in "shots", keyed by shot id.
  // Pixels are never edited after capture, so each buffer is written once and deleted when its shot is removed.
  window.NegativeLabPersistence = function createPersistence({ notify }) {
    let databasePromise = null;
    const storedPixelIds = new Set();
    let lastSavedJson = null;
    let saving = false;
    let saveFailureReported = false;
    let buildSession = null;

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
      notify("This session could not be saved in browser storage. Export your work to keep it.", true);
    }

    async function save() {
      if (!buildSession || saving) return;
      saving = true;
      let transaction = null;
      try {
        const session = buildSession();
        const shots = session.rolls.flatMap((roll) => roll.shots);
        shots.forEach((shot) => {
          shot.id ||= createId();
        });
        const record = {
          ...session,
          version: SESSION_VERSION,
          rolls: session.rolls.map((roll) => ({
            ...roll,
            shots: roll.shots.map(({ pixels, ...metadata }) => metadata)
          }))
        };
        const json = JSON.stringify(record);
        if (json === lastSavedJson) return;

        const liveIds = new Set(shots.map((shot) => shot.id));
        const newShots = shots.filter((shot) => !storedPixelIds.has(shot.id));
        const removedIds = [...storedPixelIds].filter((id) => !liveIds.has(id));

        const database = await openDatabase();
        transaction = database.transaction(["shots", "session"], "readwrite");
        const shotStore = transaction.objectStore("shots");
        newShots.forEach((shot) => shotStore.put({ id: shot.id, width: shot.width, height: shot.height, pixels: shot.pixels }));
        removedIds.forEach((id) => shotStore.delete(id));
        transaction.objectStore("session").put(record, SESSION_KEY);
        await transactionDone(transaction);

        newShots.forEach((shot) => storedPixelIds.add(shot.id));
        removedIds.forEach((id) => storedPixelIds.delete(id));
        lastSavedJson = json;
        saveFailureReported = false;
      } catch (error) {
        try { transaction?.abort(); } catch (abortError) { /* already finished */ }
        reportFailure(error);
      } finally {
        saving = false;
      }
    }

    async function load() {
      navigator.storage?.persist?.().catch(() => {});
      const database = await openDatabase();
      const transaction = database.transaction(["shots", "session"], "readonly");
      const [record, shotRecords] = await Promise.all([
        requestResult(transaction.objectStore("session").get(SESSION_KEY)),
        requestResult(transaction.objectStore("shots").getAll())
      ]);
      if (!record || record.version !== SESSION_VERSION || !Array.isArray(record.rolls)) return null;

      const shotsById = new Map(shotRecords.map((shotRecord) => [shotRecord.id, shotRecord]));
      let missingCount = 0;
      const rolls = record.rolls.map((roll) => ({
        ...roll,
        shots: roll.shots.flatMap((metadata) => {
          const stored = shotsById.get(metadata.id);
          if (!stored) {
            missingCount++;
            return [];
          }
          storedPixelIds.add(metadata.id);
          return [{ ...metadata, pixels: stored.pixels }];
        })
      }));
      if (missingCount) console.warn(`${missingCount} saved frame(s) had no image data and were skipped.`);
      lastSavedJson = null;
      return { ...record, rolls };
    }

    function startAutosave(getSession) {
      buildSession = getSession;
      setInterval(save, AUTOSAVE_INTERVAL_MS);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") save();
      });
      window.addEventListener("pagehide", save);
    }

    return { load, startAutosave };
  };
})();
