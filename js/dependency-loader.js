(() => {
  "use strict";

  const CDN_TIMEOUT_MS = 5000;
  const LOCAL_TIMEOUT_MS = 15000;
  const dependencies = {
    tailwind: {
      name: "Tailwind CSS",
      cdn: "https://cdn.tailwindcss.com/3.4.17",
      local: "vendor/tailwindcss-3.4.17.js"
    },
    openCV: {
      name: "OpenCV.js",
      cdn: "https://docs.opencv.org/4.13.0/opencv.js",
      local: "vendor/opencv-4.13.0.js"
    }
  };

  function loadScript(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      let settled = false;
      const timeout = setTimeout(() => finish(new Error(`Timed out loading ${url} after ${timeoutMs} ms.`)), timeoutMs);
      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        script.onload = null;
        script.onerror = null;
        if (error) {
          script.remove();
          reject(error);
        } else resolve();
      }
      script.async = true;
      script.src = url;
      script.onload = () => finish();
      script.onerror = () => finish(new Error(`Could not load ${url}.`));
      document.head.append(script);
    });
  }

  function showDependencyError(dependency) {
    const notice = document.createElement("div");
    notice.className = "dependency-error";
    notice.setAttribute("role", "alert");
    notice.textContent = `${dependency.name} could not load from the CDN or its local fallback. Check your connection and the vendor files.`;
    if (document.body) document.body.append(notice);
    else document.addEventListener("DOMContentLoaded", () => document.body.append(notice), { once: true });
  }

  async function loadWithFallback(dependency) {
    try {
      await loadScript(dependency.cdn, CDN_TIMEOUT_MS);
      return true;
    } catch (cdnError) {
      console.warn(`${dependency.name} CDN failed; trying the local fallback.`, cdnError);
    }
    try {
      await loadScript(dependency.local, LOCAL_TIMEOUT_MS);
      return true;
    } catch (localError) {
      console.error(`${dependency.name} CDN and local fallback both failed.`, localError);
      showDependencyError(dependency);
      return false;
    }
  }

  window.NegativeLabDependencies = {
    tailwindReady: loadWithFallback(dependencies.tailwind),
    openCVReady: loadWithFallback(dependencies.openCV)
  };
})();
