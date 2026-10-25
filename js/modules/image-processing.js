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

    const zlog2Curve = {
      a: 249.77914428710938,
      b: 0.9484496712684631,
      c: 0.3455176055431366,
      d: 0.1709400862455368,
      e: 1.3393715620040894,
      f: -0.06127290427684784,
      cut: -0.0652475655078888
    };
    let zlog2Encoder = null;

    // Reverse-engineered Z-Log2 curve only; the DCTL's optional gain and gamut transforms are separate.
    function zlog2ToLinear(encoded) {
      return encoded > zlog2Curve.e * zlog2Curve.cut + zlog2Curve.f
        ? (Math.pow(10, (encoded - zlog2Curve.d) / zlog2Curve.c) - zlog2Curve.b) / zlog2Curve.a
        : (encoded - zlog2Curve.f) / zlog2Curve.e;
    }

    const zlog2MinimumLinear = zlog2ToLinear(0);
    const zlog2MaximumLinear = zlog2ToLinear(1);
    const zlog2LinearRange = zlog2MaximumLinear - zlog2MinimumLinear;
    const zlog2InvertSum = zlog2MinimumLinear + zlog2MaximumLinear;

    function linearToZlog2(linear) {
      const encoded = linear > zlog2Curve.cut
        ? zlog2Curve.c * Math.log10(zlog2Curve.a * linear + zlog2Curve.b) + zlog2Curve.d
        : zlog2Curve.e * linear + zlog2Curve.f;
      return clamp(encoded, 0, 1);
    }

    function getZlog2Encoder() {
      if (!zlog2Encoder) {
        const values = new Uint8Array(65536);
        for (let index = 0; index < values.length; index++) {
          const linear = zlog2MinimumLinear + index / (values.length - 1) * zlog2LinearRange;
          values[index] = Math.round(linearToZlog2(linear) * 255);
        }
        zlog2Encoder = {
          minimumLinear: zlog2MinimumLinear,
          maximumLinear: zlog2MaximumLinear,
          linearRange: zlog2LinearRange,
          invertSum: zlog2InvertSum,
          values
        };
      }
      return zlog2Encoder;
    }

    function rawToLinear(value, invert, decodeZlog2 = $("#zlog2Toggle")?.checked) {
      if (decodeZlog2) {
        const decoded = zlog2ToLinear(value / 255);
        return invert ? zlog2InvertSum - decoded : decoded;
      }
      return srgbToLinear((invert ? 255 - value : value) / 255);
    }

    // Levels are stored as the raw scan range; this returns the same range in the (optionally inverted) working domain.
    function workingRange(range, invert) {
      const min = clamp(Number(range?.min ?? 0), 0, 255);
      const max = clamp(Number(range?.max ?? 255), 0, 255);
      return invert ? { min: 255 - max, max: 255 - min } : { min, max };
    }

    // Pipeline per channel: invert -> decode to linear -> normalize to the roll's min/max ->
    // brightness/contrast (pivot at the middle of the range) -> curve over the normalized range.
    function buildCurveInputLuts(imageAdjustments, invert, decodeZlog2 = $("#zlog2Toggle")?.checked) {
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
        const rawMin = clamp(Number(levels[channel]?.min ?? 0), 0, 255);
        const rawMax = clamp(Number(levels[channel]?.max ?? 255), 0, 255);
        const range = workingRange(levels[channel], invert);
        const low = decodeZlog2
          ? invert
            ? zlog2InvertSum - zlog2ToLinear(rawMax / 255)
            : zlog2ToLinear(rawMin / 255)
          : srgbToLinear(range.min / 255);
        const high = decodeZlog2
          ? invert
            ? zlog2InvertSum - zlog2ToLinear(rawMin / 255)
            : zlog2ToLinear(rawMax / 255)
          : srgbToLinear(range.max / 255);
        const span = Math.max(high - low, 0.0001);
        for (let value = 0; value < 256; value++) {
          const normalized = (rawToLinear(value, invert, decodeZlog2) - low) / span;
          const adjusted = clamp((normalized - 0.5) * contrast + 0.5 + brightness + tintOffsets[channel], 0, 1);
          channels[`${channel}Input`][value] = adjusted * 255;
          channels[channel][value] = curveValue(curves[channel], adjusted) * 255;
        }
      }
      return channels;
    }

    function buildLinearCurveInputLuts(imageAdjustments, invert) {
      const contrast = Number(imageAdjustments.contrast) / 100;
      const brightness = Number(imageAdjustments.brightness) / 255;
      const tint = Number(imageAdjustments.tint) / 255;
      const curves = imageAdjustments.curves || {};
      const levels = imageAdjustments.levels || {};
      const channels = {
        red: new Float32Array(65536),
        green: new Float32Array(65536),
        blue: new Float32Array(65536)
      };
      const tintOffsets = { red: tint, green: -tint, blue: tint };
      for (const channel of ["red", "green", "blue"]) {
        const rawMin = clamp(Number(levels[channel]?.min ?? 0), 0, 255);
        const rawMax = clamp(Number(levels[channel]?.max ?? 255), 0, 255);
        const rawLow = zlog2ToLinear(rawMin / 255);
        const rawHigh = zlog2ToLinear(rawMax / 255);
        const low = invert ? zlog2InvertSum - rawHigh : rawLow;
        const high = invert ? zlog2InvertSum - rawLow : rawHigh;
        const span = Math.max(high - low, 0.0001);
        for (let value = 0; value < 65536; value++) {
          const linear = zlog2MinimumLinear + value / 65535 * zlog2LinearRange;
          const working = invert ? zlog2InvertSum - linear : linear;
          const normalized = (working - low) / span;
          const adjusted = clamp((normalized - 0.5) * contrast + 0.5 + brightness + tintOffsets[channel], 0, 1);
          channels[channel][value] = curveValue(curves[channel], adjusted) * 255;
        }
      }
      return channels;
    }

    function buildOutputLuts(imageAdjustments, curveInputs) {
      const gamma = getGammaLut(imageAdjustments.gamma);
      const master = new Float32Array(256);
      const channels = Object.fromEntries(["red", "green", "blue"].map((channel) =>
        [channel, new Float32Array(curveInputs[channel].length)]
      ));
      for (let value = 0; value < 256; value++) {
        master[value] = curveValue(imageAdjustments.curves?.white, value / 255) * 255;
      }
      for (const channel of ["red", "green", "blue"]) channels[channel].set(curveInputs[channel]);
      return { ...channels, gamma, master };
    }

    function buildAdjustmentLuts(imageAdjustments, invert, decodeZlog2 = $("#zlog2Toggle")?.checked) {
      return buildOutputLuts(imageAdjustments, buildCurveInputLuts(imageAdjustments, invert, decodeZlog2));
    }

    function buildLinearAdjustmentLuts(imageAdjustments, invert) {
      return buildOutputLuts(imageAdjustments, buildLinearCurveInputLuts(imageAdjustments, invert));
    }

    function buildCssPreviewTables(imageAdjustments, invert, decodeZlog2 = $("#zlog2Toggle")?.checked) {
      const luts = buildAdjustmentLuts(imageAdjustments, invert, decodeZlog2);
      return Object.fromEntries(["red", "green", "blue"].map((channel) => {
        const table = new Array(256);
        for (let value = 0; value < 256; value++) {
          const channelValue = luts[channel][value];
          const masterValue = evaluateMaster(luts.master, channelValue);
          const encoded = encodeLinearValue(luts.gamma, masterValue);
          table[value] = (encoded / 255).toFixed(5);
        }
        return [channel, table.join(" ")];
      }));
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

    function rotateHue(red, green, blue, degrees) {
      if (!degrees) return [red, green, blue];
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      const delta = maximum - minimum;
      if (!delta) return [red, green, blue];
      let hue = maximum === red
        ? ((green - blue) / delta) % 6
        : maximum === green
          ? (blue - red) / delta + 2
          : (red - green) / delta + 4;
      hue = ((hue / 6 + degrees / 360) % 1 + 1) % 1;
      const saturation = maximum === 0 ? 0 : delta / maximum;
      const value = maximum;
      const sector = hue * 6;
      const chroma = value * saturation;
      const secondary = chroma * (1 - Math.abs(sector % 2 - 1));
      const offset = value - chroma;
      const [first, second, third] = sector < 1 ? [chroma, secondary, 0]
        : sector < 2 ? [secondary, chroma, 0]
          : sector < 3 ? [0, chroma, secondary]
            : sector < 4 ? [0, secondary, chroma]
              : sector < 5 ? [secondary, 0, chroma]
                : [chroma, 0, secondary];
      return [first + offset, second + offset, third + offset];
    }

    function writeProcessedPixel(data, index, imageAdjustments, luts, red, green, blue) {
      const inputLuminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
      const outputLuminance = evaluateMaster(luts.master, inputLuminance);
      const scale = inputLuminance > 0 ? outputLuminance / inputLuminance : 0;
      const [hueRed, hueGreen, hueBlue] = rotateHue(
        inputLuminance > 0 ? red * scale : outputLuminance,
        inputLuminance > 0 ? green * scale : outputLuminance,
        inputLuminance > 0 ? blue * scale : outputLuminance,
        Number(imageAdjustments.hue) || 0
      );
      const outputRed = encodeLinearValue(luts.gamma, hueRed);
      const outputGreen = encodeLinearValue(luts.gamma, hueGreen);
      const outputBlue = encodeLinearValue(luts.gamma, hueBlue);
      if (imageAdjustments.desaturate) {
        const luminance = Math.round(outputRed * 0.2126 + outputGreen * 0.7152 + outputBlue * 0.0722);
        data[index] = luminance;
        data[index + 1] = luminance;
        data[index + 2] = luminance;
      } else {
        data[index] = outputRed;
        data[index + 1] = outputGreen;
        data[index + 2] = outputBlue;
      }
    }

    function applyPixel(data, index, imageAdjustments, luts, source = data) {
      writeProcessedPixel(
        data,
        index,
        imageAdjustments,
        luts,
        lookup(luts.red, source[index]),
        lookup(luts.green, source[index + 1]),
        lookup(luts.blue, source[index + 2])
      );
    }

    function applyAdjustmentsSync(data, imageAdjustments, invert = true, decodeZlog2 = $("#zlog2Toggle")?.checked) {
      const luts = buildAdjustmentLuts(imageAdjustments, invert, decodeZlog2);
      for (let index = 0; index < data.length; index += 4) {
        applyPixel(data, index, imageAdjustments, luts);
      }
    }

    async function applyAdjustments(data, imageAdjustments, invert, onProgress = () => {}, source = data, shouldCancel = () => false, decodeZlog2 = $("#zlog2Toggle")?.checked) {
      const luts = buildAdjustmentLuts(imageAdjustments, invert, decodeZlog2);
      for (let index = 0; index < data.length; index += 4) {
        if (index && index % 262144 === 0) {
          if (shouldCancel()) return false;
          onProgress(index / data.length * 100);
          await yieldToBrowser();
        }
        applyPixel(data, index, imageAdjustments, luts, source);
      }
      if (shouldCancel()) return false;
      onProgress(100);
      return true;
    }

    async function applyLinearAdjustments(source, imageAdjustments, invert, onProgress = () => {}) {
      const luts = buildLinearAdjustmentLuts(imageAdjustments, invert);
      const pixelCount = source.length / 3;
      const output = new Uint8ClampedArray(pixelCount * 4);
      for (let sourceIndex = 0, targetIndex = 0; sourceIndex < source.length; sourceIndex += 3, targetIndex += 4) {
        if (sourceIndex && sourceIndex % 196608 === 0) {
          onProgress(sourceIndex / source.length * 100);
          await yieldToBrowser();
        }
        writeProcessedPixel(
          output,
          targetIndex,
          imageAdjustments,
          luts,
          luts.red[source[sourceIndex]],
          luts.green[source[sourceIndex + 1]],
          luts.blue[source[sourceIndex + 2]]
        );
        output[targetIndex + 3] = 255;
      }
      onProgress(100);
      return output;
    }

    function linear16ToZlog2Rgba(source) {
      const encoder = getZlog2Encoder().values;
      const output = new Uint8ClampedArray(source.length / 3 * 4);
      for (let sourceIndex = 0, targetIndex = 0; sourceIndex < source.length; sourceIndex += 3, targetIndex += 4) {
        output[targetIndex] = encoder[source[sourceIndex]];
        output[targetIndex + 1] = encoder[source[sourceIndex + 1]];
        output[targetIndex + 2] = encoder[source[sourceIndex + 2]];
        output[targetIndex + 3] = 255;
      }
      return output;
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
      let linearOutput = null;
      const linearShot = shot.pixelEncoding === "linear16-zlog2";
      try {
        onProgress({ stage: "Cropping and straightening", current: 0, total: 1, percent: 5 });
        await yieldToBrowser();
        source = new cv.Mat(shot.height, shot.width, linearShot ? cv.CV_16UC3 : cv.CV_8UC4);
        if (linearShot) source.data16U.set(shot.pixels);
        else source.data.set(shot.pixels);
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
        let final = warped;
        if (linearShot) {
          const imageAdjustments = adjustments || {
            mode: "color", brightness: 0, contrast: 100, tint: 0, gamma: "srgb", curves: {}
          };
          const output = raw
            ? linear16ToZlog2Rgba(warped.data16U)
            : await applyLinearAdjustments(warped.data16U, imageAdjustments, invert, (percent) => onProgress({
              stage: "Applying curves and output transform",
              current: 1,
              total: 1,
              percent: 15 + percent * 0.8
            }));
          linearOutput = new cv.Mat(outputHeight, outputWidth, cv.CV_8UC4);
          linearOutput.data.set(output);
          warped.delete();
          warped = null;
          final = linearOutput;
        } else if (!raw) {
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
        if (shot.flipX || shot.flipY) {
          flipped = new cv.Mat();
          cv.flip(final, flipped, shot.flipX && shot.flipY ? -1 : shot.flipX ? 1 : 0);
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
        linearOutput?.delete();
      }
    }

    return {
      processShot, applyAdjustments, applyAdjustmentsSync, applyLinearAdjustments,
      buildAdjustmentLuts, buildLinearAdjustmentLuts, buildCssPreviewTables,
      buildCurveInputLuts, rawToLinear, workingRange, zlog2ToLinear,
      linearToZlog2, getZlog2Encoder, linear16ToZlog2Rgba
    };
  };
})();
