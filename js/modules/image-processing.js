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

    function transformedCorners(shot, frame) {
      return frame.corners.map((point, index) => ({
        x: clamp(point.x + shot.quad[index].x - shot.autoQuad[index].x, 0, shot.width),
        y: clamp(point.y + shot.quad[index].y - shot.autoQuad[index].y, 0, shot.height)
      }));
    }

    // Linear interpolation so fractional (averaged) inputs keep their sub-code precision.
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

    async function processShot(shot, { raw = false, stitch = false, preview = false, adjustments = null, onProgress = () => {} } = {}) {
      if (!state.cvReady) throw new Error("OpenCV.js is not ready. Check your internet connection and reload this page.");
      const count = stitch && $("#averageToggle").checked ? Number($("#averageCount").value) : 1;
      const chosenFrames = shot.frames.slice(0, count);
      const firstCorners = transformedCorners(shot, chosenFrames[0]);
      const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      const outputWidth = Math.max(1, Math.round(Math.min(shot.width,
        (distance(firstCorners[0], firstCorners[1]) + distance(firstCorners[3], firstCorners[2])) / 2)));
      const outputHeight = Math.max(1, Math.round(Math.min(shot.height,
        (distance(firstCorners[0], firstCorners[3]) + distance(firstCorners[1], firstCorners[2])) / 2)));
      const destination = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outputWidth, 0, outputWidth, outputHeight, 0, outputHeight]);
      let average = null;
      let floatAverage = null;
      let flipped = null;
      try {
        let processedFrames = 0;
        onProgress({ stage: "Preparing frame alignment", current: 0, total: chosenFrames.length, percent: 0 });
        await yieldToBrowser();
        for (const [frameIndex, frame] of chosenFrames.entries()) {
          onProgress({
            stage: `Aligning frame ${frameIndex + 1} of ${chosenFrames.length}`,
            current: frameIndex,
            total: chosenFrames.length,
            percent: frameIndex / chosenFrames.length * 85
          });
          await yieldToBrowser();
          let source = null;
          let sourcePoints = null;
          let transform = null;
          let warped = null;
          try {
            source = new cv.Mat(shot.height, shot.width, cv.CV_8UC4);
            sourcePoints = cv.matFromArray(4, 1, cv.CV_32FC2,
              transformedCorners(shot, frame).flatMap(({ x, y }) => [x, y]));
            transform = cv.getPerspectiveTransform(sourcePoints, destination);
            warped = new cv.Mat();
            source.data.set(frame.pixels);
            cv.warpPerspective(source, warped, transform, new cv.Size(outputWidth, outputHeight), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
            // Accumulate in float so averaging adds real sub-code precision instead of re-rounding to 8 bits.
            warped.convertTo(warped, cv.CV_32FC4);
            if (!average) average = warped.clone();
            else cv.addWeighted(average, processedFrames / (processedFrames + 1), warped, 1 / (processedFrames + 1), 0, average);
            processedFrames++;
          } finally {
            source?.delete();
            sourcePoints?.delete();
            transform?.delete();
            warped?.delete();
          }
        }
        if (!average) throw new Error("No frames were available to process.");
        onProgress({ stage: "Applying curves and output transform", current: chosenFrames.length, total: chosenFrames.length, percent: 88 });
        await yieldToBrowser();
        const invert = !raw && ($("#invertToggle")?.checked ?? true);
        floatAverage = average;
        average = new cv.Mat();
        floatAverage.convertTo(average, cv.CV_8UC4);
        if (!raw) {
          const imageAdjustments = adjustments || {
            mode: "color", brightness: 0, contrast: 100, tint: 0, gamma: "srgb", curves: {}
          };
          await applyAdjustments(average.data, imageAdjustments, invert, (percent) => onProgress({
            stage: "Applying curves and output transform",
            current: chosenFrames.length,
            total: chosenFrames.length,
            percent: 88 + percent * 0.07
          }), floatAverage.data32F);
          for (let index = 3; index < average.data.length; index += 4) average.data[index] = 255;
        }
        let final = average;
        if (shot.flipX || shot.flipY) {
          flipped = new cv.Mat();
          cv.flip(average, flipped, shot.flipX && shot.flipY ? -1 : shot.flipX ? 1 : 0);
          final = flipped;
        }
        const result = document.createElement("canvas");
        result.width = final.cols;
        result.height = final.rows;
        onProgress({ stage: "Encoding PNG preview", current: chosenFrames.length, total: chosenFrames.length, percent: 99 });
        await yieldToBrowser();
        cv.imshow(result, final);
        const blob = await new Promise((resolve, reject) => result.toBlob((value) => value ? resolve(value) : reject(new Error("PNG encoding failed.")), "image/png"));
        onProgress({ stage: "Complete", current: chosenFrames.length, total: chosenFrames.length, percent: 100 });
        return blob;
      } finally {
        destination.delete();
        floatAverage?.delete();
        average?.delete();
        flipped?.delete();
      }
    }

    return { processShot, applyAdjustments, applyAdjustmentsSync, buildAdjustmentLuts, buildCurveInputLuts, rawToLinear, workingRange };
  };
})();
