(() => {
  "use strict";

  window.NegativeLabImageProcessing = function createImageProcessor({ state, $, clamp }) {
    const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0));
    const gammaLuts = new Map();

    function curveValue(points, input) {
      const source = Array.isArray(points) && points.length >= 2
        ? points
        : [{ x: 0, y: 0 }, { x: 1, y: 1 }];
      const sorted = source
        .map(({ x, y }) => ({ x: clamp(Number(x), 0, 1), y: clamp(Number(y), 0, 1) }))
        .sort((first, second) => first.x - second.x);
      let segment = 0;
      const x = clamp(input, 0, 1);
      while (segment < sorted.length - 2 && x > sorted[segment + 1].x) segment++;
      const first = sorted[segment];
      const second = sorted[segment + 1];
      const amount = clamp((x - first.x) / Math.max(second.x - first.x, .0001), 0, 1);
      return clamp(first.y + (second.y - first.y) * amount, 0, 1);
    }

    function encodeGamma(linear, gamma) {
      if (gamma === "2.2") return Math.pow(linear, 1 / 2.2);
      if (gamma === "off") return linear;
      return linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
    }

    function getGammaLut(gamma) {
      if (!gammaLuts.has(gamma)) {
        const lut = new Uint8ClampedArray(65536);
        for (let index = 0; index < lut.length; index++) {
          lut[index] = Math.round(encodeGamma(index / 65535, gamma) * 255);
        }
        gammaLuts.set(gamma, lut);
      }
      return gammaLuts.get(gamma);
    }

    function srgbToLinear(encoded) {
      return encoded <= 0.04045
        ? encoded / 12.92
        : Math.pow((encoded + 0.055) / 1.055, 2.4);
    }

    // Z-Log2 -> scene linear (community-fitted curve, normalized so 18% gray lands near 0.18).
    function zlog2ToLinear(x) {
      const cut = 0.12658, a = 0.01579, b = 150, c = 1.0543, d = 139.73, gain = 13.5;
      const logPart = (value) => (Math.pow(b, value * c) - a) / d;
      // The linear toe's slope is derived so both segments meet at the cut (no jump in the shadows).
      return (x < cut ? x * (logPart(cut) / cut) : logPart(x)) * gain;
    }

    function decodeToLinear(encoded) {
      return $("#zlog2Toggle")?.checked ? zlog2ToLinear(encoded) : srgbToLinear(encoded);
    }

    function rawToLinear(value, invert) {
      return decodeToLinear((invert ? 255 - value : value) / 255);
    }

    // Levels are stored as the raw scan range; this returns the same range in the (optionally inverted) working domain.
    function workingRange(range, invert) {
      const min = clamp(Number(range?.min ?? 0), 0, 255);
      const max = clamp(Number(range?.max ?? 255), 0, 255);
      return invert ? { min: 255 - max, max: 255 - min } : { min, max };
    }

    // Pipeline per channel: invert -> decode to linear -> normalize to the roll's min/max ->
    // brightness/contrast (pivot at the middle of the range) -> curve over the normalized range.
    function buildCurveInputLuts(imageAdjustments, invert) {
      const contrast = Number(imageAdjustments.contrast) / 100;
      const brightness = Number(imageAdjustments.brightness) / 255;
      const tint = Number(imageAdjustments.tint) / 255;
      const curves = imageAdjustments.curves || {};
      const levels = imageAdjustments.levels || {};
      const channels = {
        red: new Float32Array(256),
        green: new Float32Array(256),
        blue: new Float32Array(256),
        redInput: new Float32Array(256),
        greenInput: new Float32Array(256),
        blueInput: new Float32Array(256)
      };
      const tintOffsets = { red: tint, green: -tint, blue: tint };
      for (const channel of ["red", "green", "blue"]) {
        const range = workingRange(levels[channel], invert);
        const low = decodeToLinear(range.min / 255);
        const span = Math.max(decodeToLinear(range.max / 255) - low, 0.0001);
        for (let value = 0; value < 256; value++) {
          const normalized = (rawToLinear(value, invert) - low) / span;
          const adjusted = clamp((normalized - 0.5) * contrast + 0.5 + brightness + tintOffsets[channel], 0, 1);
          channels[`${channel}Input`][value] = adjusted * 255;
          channels[channel][value] = curveValue(curves[channel], adjusted) * 255;
        }
      }
      return channels;
    }

    function buildAdjustmentLuts(imageAdjustments, invert) {
      const curveInputs = buildCurveInputLuts(imageAdjustments, invert);
      const gamma = getGammaLut(imageAdjustments.gamma);
      const master = new Float32Array(256);
      const channels = {
        red: new Float32Array(256),
        green: new Float32Array(256),
        blue: new Float32Array(256)
      };
      for (let value = 0; value < 256; value++) {
        master[value] = curveValue(imageAdjustments.curves?.white, value / 255) * 255;
        for (const channel of ["red", "green", "blue"]) {
          channels[channel][value] = curveInputs[channel][value];
        }
      }
      return { ...channels, gamma, master };
    }

    function encodeLinearValue(lut, value) {
      return lut[Math.round(clamp(value / 255, 0, 1) * 65535)];
    }

    function evaluateMaster(lut, luminance) {
      const input = clamp(luminance, 0, 255);
      const lower = Math.floor(input);
      const upper = Math.min(255, lower + 1);
      const fraction = input - lower;
      return lut[lower] + (lut[upper] - lut[lower]) * fraction;
    }

    // Linear interpolation between adjacent codes keeps the curve smooth between 8-bit inputs.
    function lookup(lut, value) {
      const input = clamp(value, 0, 255);
      const lower = Math.floor(input);
      const upper = Math.min(255, lower + 1);
      return lut[lower] + (lut[upper] - lut[lower]) * (input - lower);
    }

    function applyPixel(data, index, imageAdjustments, luts, source = data) {
      const red = lookup(luts.red, source[index]);
      const green = lookup(luts.green, source[index + 1]);
      const blue = lookup(luts.blue, source[index + 2]);
      const inputLuminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
      const outputLuminance = evaluateMaster(luts.master, inputLuminance);
      if (imageAdjustments.mode === "bw") {
        const luminance = encodeLinearValue(luts.gamma, outputLuminance);
        data[index] = luminance;
        data[index + 1] = luminance;
        data[index + 2] = luminance;
      } else {
        const scale = inputLuminance > 0 ? outputLuminance / inputLuminance : 0;
        data[index] = encodeLinearValue(luts.gamma, inputLuminance > 0 ? red * scale : outputLuminance);
        data[index + 1] = encodeLinearValue(luts.gamma, inputLuminance > 0 ? green * scale : outputLuminance);
        data[index + 2] = encodeLinearValue(luts.gamma, inputLuminance > 0 ? blue * scale : outputLuminance);
      }
    }

    function applyAdjustmentsSync(data, imageAdjustments, invert = true) {
      const luts = buildAdjustmentLuts(imageAdjustments, invert);
      for (let index = 0; index < data.length; index += 4) {
        applyPixel(data, index, imageAdjustments, luts);
      }
    }

    async function applyAdjustments(data, imageAdjustments, invert, onProgress = () => {}, source = data) {
      const luts = buildAdjustmentLuts(imageAdjustments, invert);
      for (let index = 0; index < data.length; index += 4) {
        if (index && index % 262144 === 0) {
          onProgress(index / data.length * 100);
          await yieldToBrowser();
        }
        applyPixel(data, index, imageAdjustments, luts, source);
      }
      onProgress(100);
    }

    async function processShot(shot, { raw = false, preview = false, adjustments = null, onProgress = () => {} } = {}) {
      if (!state.cvReady) throw new Error("OpenCV.js is not ready. Check your internet connection and reload this page.");
      const corners = shot.quad;
      const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      const outputWidth = Math.max(1, Math.round(Math.min(shot.width,
        (distance(corners[0], corners[1]) + distance(corners[3], corners[2])) / 2)));
      const outputHeight = Math.max(1, Math.round(Math.min(shot.height,
        (distance(corners[0], corners[3]) + distance(corners[1], corners[2])) / 2)));
      const destination = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outputWidth, 0, outputWidth, outputHeight, 0, outputHeight]);
      let source = null;
      let sourcePoints = null;
      let transform = null;
      let warped = null;
      let flipped = null;
      try {
        onProgress({ stage: "Cropping and straightening", current: 0, total: 1, percent: 5 });
        await yieldToBrowser();
        source = new cv.Mat(shot.height, shot.width, cv.CV_8UC4);
        source.data.set(shot.pixels);
        sourcePoints = cv.matFromArray(4, 1, cv.CV_32FC2, corners.flatMap(({ x, y }) => [x, y]));
        transform = cv.getPerspectiveTransform(sourcePoints, destination);
        warped = new cv.Mat();
        cv.warpPerspective(source, warped, transform, new cv.Size(outputWidth, outputHeight), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
        // The stored asset is already averaged, so the source Mat can be released before the adjustment pass.
        source.delete();
        source = null;
        onProgress({ stage: "Applying curves and output transform", current: 1, total: 1, percent: 15 });
        await yieldToBrowser();
        const invert = !raw && ($("#invertToggle")?.checked ?? true);
        if (!raw) {
          const imageAdjustments = adjustments || {
            mode: "color", brightness: 0, contrast: 100, tint: 0, gamma: "srgb", curves: {}
          };
          await applyAdjustments(warped.data, imageAdjustments, invert, (percent) => onProgress({
            stage: "Applying curves and output transform",
            current: 1,
            total: 1,
            percent: 15 + percent * 0.8
          }));
          for (let index = 3; index < warped.data.length; index += 4) warped.data[index] = 255;
        }
        let final = warped;
        if (shot.flipX || shot.flipY) {
          flipped = new cv.Mat();
          cv.flip(warped, flipped, shot.flipX && shot.flipY ? -1 : shot.flipX ? 1 : 0);
          final = flipped;
        }
        const result = document.createElement("canvas");
        result.width = final.cols;
        result.height = final.rows;
        // Create the context first so cv.imshow reuses it with the CPU-backed flag.
        result.getContext("2d", { willReadFrequently: true });
        onProgress({ stage: "Encoding PNG preview", current: 1, total: 1, percent: 99 });
        await yieldToBrowser();
        cv.imshow(result, final);
        const blob = await new Promise((resolve, reject) => result.toBlob((value) => value ? resolve(value) : reject(new Error("PNG encoding failed.")), "image/png"));
        result.width = 0;
        result.height = 0;
        onProgress({ stage: "Complete", current: 1, total: 1, percent: 100 });
        return blob;
      } finally {
        destination.delete();
        source?.delete();
        sourcePoints?.delete();
        transform?.delete();
        warped?.delete();
        flipped?.delete();
      }
    }

    return { processShot, applyAdjustments, applyAdjustmentsSync, buildAdjustmentLuts, buildCurveInputLuts, rawToLinear, workingRange };
  };
})();
