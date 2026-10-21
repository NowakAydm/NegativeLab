(() => {
  "use strict";

  function findPerforations(gray) {
    const binary = new cv.Mat();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    const centers = [];
    try {
      cv.threshold(gray, binary, 180, 255, cv.THRESH_BINARY);
      cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      for (let index = 0; index < contours.size(); index++) {
        const contour = contours.get(index);
        try {
          const bounds = cv.boundingRect(contour);
          const shorter = Math.min(bounds.width, bounds.height);
          const longer = Math.max(bounds.width, bounds.height);
          const ratio = longer / Math.max(shorter, 1);
          if (shorter >= 3 && shorter <= 18 && longer >= 5 && longer <= 32 && ratio >= 1.25 && ratio <= 2.8) {
            centers.push({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
          }
        } finally {
          contour.delete();
        }
      }
    } finally {
      binary.delete();
      contours.delete();
      hierarchy.delete();
    }
    return centers;
  }

  function perforationSupport(corners, centers) {
    if (centers.length < 4) return 0;
    const sideSupport = corners.map((start, index) => {
      const end = corners[(index + 1) % 4];
      const edgeX = end.x - start.x;
      const edgeY = end.y - start.y;
      const edgeLength = Math.hypot(edgeX, edgeY);
      const centerX = corners.reduce((sum, point) => sum + point.x, 0) / 4;
      const centerY = corners.reduce((sum, point) => sum + point.y, 0) / 4;
      const centerSide = edgeX * (centerY - start.y) - edgeY * (centerX - start.x);
      const positions = centers.flatMap((point) => {
        const along = ((point.x - start.x) * edgeX + (point.y - start.y) * edgeY) / (edgeLength * edgeLength);
        const side = edgeX * (point.y - start.y) - edgeY * (point.x - start.x);
        const distance = Math.abs(side) / edgeLength;
        return along > .08 && along < .92 && distance >= 4 && distance <= 90 && side * centerSide < 0 ? [along] : [];
      }).sort((a, b) => a - b);
      if (positions.length < 4) return 0;
      const gaps = positions.slice(1).map((position, gapIndex) => position - positions[gapIndex]);
      const typicalGap = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
      const regularity = gaps.filter((gap) => gap >= typicalGap * .55 && gap <= typicalGap * 1.65).length / gaps.length;
      return Math.min(1, positions.length / 6) * regularity;
    });
    return Math.max(sideSupport[0] * sideSupport[2], sideSupport[1] * sideSupport[3]);
  }

  function frameContour(gray) {
    const perforations = findPerforations(gray);
    const edges = new cv.Mat();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    let result = null;
    try {
      cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
      cv.Canny(gray, edges, 35, 110);
      cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      let bestScore = 0;
      for (let index = 0; index < contours.size(); index++) {
        const contour = contours.get(index);
        const perimeter = cv.arcLength(contour, true);
        const approx = new cv.Mat();
        try {
          cv.approxPolyDP(contour, approx, 0.025 * perimeter, true);
          const area = cv.contourArea(approx);
          const points = [];
          if (approx.rows === 4) {
            for (let point = 0; point < 4; point++) {
              points.push({ x: approx.data32S[point * 2], y: approx.data32S[point * 2 + 1] });
            }
          }
          const center = points.length === 4
            ? {
                x: points.reduce((sum, point) => sum + point.x, 0) / 4,
                y: points.reduce((sum, point) => sum + point.y, 0) / 4
              }
            : null;
          const ordered = center
            ? points.sort((a, b) => Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x))
            : points;
          const start = ordered.length === 4
            ? ordered.reduce((best, point, pointIndex) => point.x + point.y < ordered[best].x + ordered[best].y ? pointIndex : best, 0)
            : 0;
          const corners = ordered.length === 4 ? ordered.slice(start).concat(ordered.slice(0, start)) : [];
          const edgeWidth = corners.length === 4
            ? (Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y) +
              Math.hypot(corners[2].x - corners[3].x, corners[2].y - corners[3].y)) / 2
            : 0;
          const edgeHeight = corners.length === 4
            ? (Math.hypot(corners[2].x - corners[1].x, corners[2].y - corners[1].y) +
              Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y)) / 2
            : 0;
          const ratio = edgeWidth / edgeHeight;
          const plausibleRatio = (ratio > 1.22 && ratio < 1.82) || (ratio > .54 && ratio < .82);
          const support = corners.length === 4 ? perforationSupport(corners, perforations) : 0;
          const score = area * (1 + 3 * support);
          if (corners.length === 4 && plausibleRatio && area > gray.cols * gray.rows * .09 && score > bestScore) {
            bestScore = score;
            result = corners.map(({ x, y }) => ({ x, y }));
          }
        } finally {
          approx.delete();
          contour.delete();
        }
      }
    } finally {
      edges.delete();
      contours.delete();
      hierarchy.delete();
    }
    return result;
  }

  function detectFrameCorners(pixels, width, height, sourceCanvas = null) {
    const detectWidth = 640;
    const detectHeight = Math.max(240, Math.round(detectWidth * height / width));
    const canvas = document.createElement("canvas");
    canvas.width = detectWidth;
    canvas.height = detectHeight;
    let imageCanvas = sourceCanvas;
    if (!imageCanvas) {
      imageCanvas = document.createElement("canvas");
      imageCanvas.width = width;
      imageCanvas.height = height;
      imageCanvas.getContext("2d").putImageData(new ImageData(pixels, width, height), 0, 0);
    }
    canvas.getContext("2d", { willReadFrequently: true }).drawImage(imageCanvas, 0, 0, detectWidth, detectHeight);
    const rgba = cv.imread(canvas);
    const gray = new cv.Mat();
    try {
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
      const corners = frameContour(gray);
      return corners?.map(({ x, y }) => ({ x: x * width / detectWidth, y: y * height / detectHeight })) || null;
    } finally {
      rgba.delete();
      gray.delete();
    }
  }

  function detectFilmGuides(pixels, width, height, sourceCanvas = null) {
    const detectWidth = 640;
    const detectHeight = Math.max(240, Math.round(detectWidth * height / width));
    const canvas = document.createElement("canvas");
    canvas.width = detectWidth;
    canvas.height = detectHeight;
    let source = sourceCanvas;
    if (!source) {
      source = document.createElement("canvas");
      source.width = width;
      source.height = height;
      source.getContext("2d").putImageData(new ImageData(pixels, width, height), 0, 0);
    }
    canvas.getContext("2d", { willReadFrequently: true }).drawImage(source, 0, 0, detectWidth, detectHeight);
    const rgba = cv.imread(canvas);
    const gray = new cv.Mat();
    const edges = new cv.Mat();
    const lines = new cv.Mat();
    try {
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
      cv.Canny(gray, edges, 35, 110);
      cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 35, Math.min(detectWidth, detectHeight) * .28, 18);
      const candidates = [];
      for (let index = 0; index < lines.rows; index++) {
        const x1 = lines.data32S[index * 4];
        const y1 = lines.data32S[index * 4 + 1];
        const x2 = lines.data32S[index * 4 + 2];
        const y2 = lines.data32S[index * 4 + 3];
        const length = Math.hypot(x2 - x1, y2 - y1);
        if (length < Math.min(detectWidth, detectHeight) * .28) continue;
        let angle = Math.atan2(y2 - y1, x2 - x1);
        if (angle < 0) angle += Math.PI;
        candidates.push({ x1, y1, x2, y2, length, angle, midX: (x1 + x2) / 2, midY: (y1 + y2) / 2 });
      }
      let bestPair = null;
      let bestScore = 0;
      for (let firstIndex = 0; firstIndex < candidates.length; firstIndex++) {
        const first = candidates[firstIndex];
        for (let secondIndex = firstIndex + 1; secondIndex < candidates.length; secondIndex++) {
          const second = candidates[secondIndex];
          const angleDifference = Math.abs(first.angle - second.angle);
          if (Math.min(angleDifference, Math.PI - angleDifference) > Math.PI / 18) continue;
          const angle = first.angle + (angleDifference > Math.PI / 2 ? Math.PI : 0);
          const axis = { x: Math.cos(angle), y: Math.sin(angle) };
          const normal = { x: -axis.y, y: axis.x };
          const firstProjection = [first.x1 * axis.x + first.y1 * axis.y, first.x2 * axis.x + first.y2 * axis.y].sort((a, b) => a - b);
          const secondProjection = [second.x1 * axis.x + second.y1 * axis.y, second.x2 * axis.x + second.y2 * axis.y].sort((a, b) => a - b);
          const overlap = Math.max(0, Math.min(firstProjection[1], secondProjection[1]) - Math.max(firstProjection[0], secondProjection[0]));
          const overlapRatio = overlap / Math.min(first.length, second.length);
          const separation = Math.abs((second.midX - first.midX) * normal.x + (second.midY - first.midY) * normal.y);
          if (overlapRatio < .55 || separation < Math.min(detectWidth, detectHeight) * .14 || separation > Math.min(detectWidth, detectHeight) * .86) continue;
          const score = (first.length + second.length) * overlapRatio * (1 - Math.min(angleDifference, Math.PI - angleDifference) / (Math.PI / 18));
          if (score > bestScore) {
            bestScore = score;
            bestPair = [first, second].map((line) => {
              const endpoints = [{ x: line.x1, y: line.y1 }, { x: line.x2, y: line.y2 }];
              endpoints.sort((a, b) => a.x * axis.x + a.y * axis.y - (b.x * axis.x + b.y * axis.y));
              return endpoints;
            }).sort((a, b) => {
              const firstProjection = ((a[0].x + a[1].x) / 2) * normal.x + ((a[0].y + a[1].y) / 2) * normal.y;
              const secondProjection = ((b[0].x + b[1].x) / 2) * normal.x + ((b[0].y + b[1].y) / 2) * normal.y;
              return firstProjection - secondProjection;
            });
          }
        }
      }
      if (!bestPair) return null;
      return bestPair.flat().map(({ x, y }) => ({ x: x * width / detectWidth, y: y * height / detectHeight }));
    } finally {
      rgba.delete();
      gray.delete();
      edges.delete();
      lines.delete();
    }
  }

  window.NegativeLabVision = { frameContour, detectFrameCorners, detectFilmGuides };
})();
