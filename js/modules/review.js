(() => {
  "use strict";

  window.NegativeLabReview = function createReview({ state, $, activeRoll, activeShot, pad, clamp, notify, setMode, updateCounts, renderFilmList, makeThumbnail, updatePreviewFilter, applyPreviewAdjustments }) {
    const canvas = $("#reviewCanvas");
    const context = canvas.getContext("2d");
    const sourceCanvas = document.createElement("canvas");
    let sourceShot = null;
    let processedPreviewShot = null;
    let processedPreviewKey = "";
    let processedPreviewCanvas = null;
    const rectangleAspect = 3 / 2;
    const adjustmentModes = [
      ["cornerAdjustMode", "corners"],
      ["rectangleAdjustMode", "rectangle"],
      ["filmAdjustMode", "film"]
    ];

    function midpoint(first, second) {
      return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    }

    function rectangleFromDiagonal(topLeft, bottomRight) {
      const dx = bottomRight.x - topLeft.x;
      const dy = bottomRight.y - topLeft.y;
      const diagonal = Math.hypot(dx, dy);
      if (diagonal < 1) return null;
      const diagonalAngle = Math.atan2(dy, dx);
      const angle = diagonalAngle - Math.atan2(1, rectangleAspect);
      const axis = { x: Math.cos(angle), y: Math.sin(angle) };
      const crossAxis = { x: -axis.y, y: axis.x };
      const halfWidth = diagonal * rectangleAspect / Math.sqrt(rectangleAspect ** 2 + 1) / 2;
      const halfHeight = diagonal / Math.sqrt(rectangleAspect ** 2 + 1) / 2;
      const center = midpoint(topLeft, bottomRight);
      return [
        { x: center.x - axis.x * halfWidth - crossAxis.x * halfHeight, y: center.y - axis.y * halfWidth - crossAxis.y * halfHeight },
        { x: center.x + axis.x * halfWidth - crossAxis.x * halfHeight, y: center.y + axis.y * halfWidth - crossAxis.y * halfHeight },
        { x: center.x + axis.x * halfWidth + crossAxis.x * halfHeight, y: center.y + axis.y * halfWidth + crossAxis.y * halfHeight },
        { x: center.x - axis.x * halfWidth + crossAxis.x * halfHeight, y: center.y - axis.y * halfWidth + crossAxis.y * halfHeight }
      ];
    }

    function rectangleFitsImage(shot, quad) {
      const rightEdge = Math.max(0, shot.width - 1);
      const bottomEdge = Math.max(0, shot.height - 1);
      return quad.every(({ x, y }) => x >= 0 && y >= 0 && x <= rightEdge && y <= bottomEdge);
    }

    function rectangleFromQuad(shot, points = shot.quad) {
      let rectangle = rectangleFromDiagonal(points[0], points[2]);
      if (!rectangle || rectangleFitsImage(shot, rectangle)) return rectangle || points;
      const center = midpoint(points[0], points[2]);
      const dx = points[2].x - points[0].x;
      const dy = points[2].y - points[0].y;
      let lowerScale = 0;
      let upperScale = 1;
      let fitted = null;
      for (let attempt = 0; attempt < 24; attempt++) {
        const scale = (lowerScale + upperScale) / 2;
        const halfX = dx * scale / 2;
        const halfY = dy * scale / 2;
        const candidate = rectangleFromDiagonal(
          { x: center.x - halfX, y: center.y - halfY },
          { x: center.x + halfX, y: center.y + halfY }
        );
        if (candidate && rectangleFitsImage(shot, candidate)) {
          lowerScale = scale;
          fitted = candidate;
        } else upperScale = scale;
      }
      return fitted || rectangle;
    }

    function dragRectangleCorner(shot, handle, target) {
      const fixed = shot.quad[handle === 0 ? 2 : 0];
      const dx = target.x - fixed.x;
      const dy = target.y - fixed.y;
      let lowerScale = 0;
      let upperScale = 1;
      let fitted = null;
      for (let attempt = 0; attempt < 24; attempt++) {
        const scale = (lowerScale + upperScale) / 2;
        const moving = { x: fixed.x + dx * scale, y: fixed.y + dy * scale };
        const topLeft = handle === 0 ? moving : fixed;
        const bottomRight = handle === 0 ? fixed : moving;
        const candidate = rectangleFromDiagonal(topLeft, bottomRight);
        if (candidate && rectangleFitsImage(shot, candidate)) {
          lowerScale = scale;
          fitted = candidate;
        } else upperScale = scale;
      }
      return fitted;
    }

    // Orders corners clockwise on screen as TL, TR, BR, BL so labels 1-4 always match their positions.
    function canonicalQuad(points) {
      const center = points.reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), { x: 0, y: 0 });
      const sorted = points
        .map((point) => ({ x: point.x, y: point.y, angle: Math.atan2(point.y - center.y, point.x - center.x) }))
        .sort((first, second) => first.angle - second.angle);
      const topLeft = -3 * Math.PI / 4;
      const distanceToTopLeft = (angle) => Math.abs(Math.atan2(Math.sin(angle - topLeft), Math.cos(angle - topLeft)));
      let start = 0;
      sorted.forEach((point, index) => {
        if (distanceToTopLeft(point.angle) < distanceToTopLeft(sorted[start].angle)) start = index;
      });
      return [0, 1, 2, 3].map((offset) => {
        const { x, y } = sorted[(start + offset) % 4];
        return { x, y };
      });
    }

    function filmGeometry(shot) {
      let guides = shot.filmGuides;
      if (!guides || guides.length !== 4) {
        guides = [shot.autoQuad[0], shot.autoQuad[1], shot.autoQuad[3], shot.autoQuad[2]]
          .map(({ x, y }) => ({ x, y }));
        shot.filmGuides = guides;
      }
      const firstLength = Math.hypot(guides[1].x - guides[0].x, guides[1].y - guides[0].y);
      const secondLength = Math.hypot(guides[3].x - guides[2].x, guides[3].y - guides[2].y);
      if (firstLength < 1 || secondLength < 1) return null;
      let firstAxis = { x: (guides[1].x - guides[0].x) / firstLength, y: (guides[1].y - guides[0].y) / firstLength };
      let secondAxis = { x: (guides[3].x - guides[2].x) / secondLength, y: (guides[3].y - guides[2].y) / secondLength };
      if (firstAxis.x * secondAxis.x + firstAxis.y * secondAxis.y < 0) secondAxis = { x: -secondAxis.x, y: -secondAxis.y };
      const axisLength = Math.hypot(firstAxis.x + secondAxis.x, firstAxis.y + secondAxis.y) || 1;
      const axis = { x: (firstAxis.x + secondAxis.x) / axisLength, y: (firstAxis.y + secondAxis.y) / axisLength };
      const firstMid = midpoint(guides[0], guides[1]);
      const secondMid = midpoint(guides[2], guides[3]);
      let crossAxis = { x: -axis.y, y: axis.x };
      if ((secondMid.x - firstMid.x) * crossAxis.x + (secondMid.y - firstMid.y) * crossAxis.y < 0) {
        crossAxis = { x: -crossAxis.x, y: -crossAxis.y };
      }
      const centerLineLength = Math.hypot(secondMid.x - firstMid.x, secondMid.y - firstMid.y);
      if (centerLineLength < 1) return null;
      const railLength = (firstLength + secondLength) / 2;
      const railMid = midpoint(firstMid, secondMid);
      if (!shot.filmCrop) shot.filmCrop = { centerT: .5, width: railLength };
      const centerT = Number.isFinite(shot.filmCrop.centerT) ? shot.filmCrop.centerT : .5;
      const center = {
        x: railMid.x + axis.x * (centerT - .5) * railLength,
        y: railMid.y + axis.y * (centerT - .5) * railLength
      };
      const imageCorners = [
        { x: 0, y: 0 }, { x: shot.width, y: 0 },
        { x: shot.width, y: shot.height }, { x: 0, y: shot.height }
      ];
      const uDistances = imageCorners.map((point) => (point.x - center.x) * axis.x + (point.y - center.y) * axis.y);
      const vDistances = imageCorners.map((point) => (point.x - center.x) * crossAxis.x + (point.y - center.y) * crossAxis.y);
      const halfWidthBound = Math.min(Math.max(...uDistances), -Math.min(...uDistances));
      const halfHeightBound = Math.min(Math.max(...vDistances), -Math.min(...vDistances));
      const maxWidth = Math.max(1, Math.min(railLength, centerLineLength * 1.5, halfWidthBound * 2, halfHeightBound * 3));
      shot.filmCrop.width = clamp(shot.filmCrop.width, Math.min(maxWidth, Math.min(shot.width, shot.height) * .1), maxWidth);
      const halfWidth = shot.filmCrop.width / 2;
      const halfHeight = shot.filmCrop.width / 3;
      const minimumT = Math.min(.49, halfWidth / railLength);
      shot.filmCrop.centerT = clamp(centerT, minimumT, 1 - minimumT);
      const cropCenter = {
        x: railMid.x + axis.x * (shot.filmCrop.centerT - .5) * railLength,
        y: railMid.y + axis.y * (shot.filmCrop.centerT - .5) * railLength
      };
      const centerLineStart = {
        x: railMid.x - axis.x * railLength / 2,
        y: railMid.y - axis.y * railLength / 2
      };
      const centerLineEnd = {
        x: railMid.x + axis.x * railLength / 2,
        y: railMid.y + axis.y * railLength / 2
      };
      return { guides, firstMid, secondMid, centerLineLength, railLength, railMid, centerLineStart, centerLineEnd, axis, crossAxis, center: cropCenter, halfWidth, halfHeight, maxWidth };
    }

    function filmCropCorners(geometry) {
      const { center, axis, crossAxis, halfWidth, halfHeight } = geometry;
      return [
        { x: center.x - axis.x * halfWidth - crossAxis.x * halfHeight, y: center.y - axis.y * halfWidth - crossAxis.y * halfHeight },
        { x: center.x + axis.x * halfWidth - crossAxis.x * halfHeight, y: center.y + axis.y * halfWidth - crossAxis.y * halfHeight },
        { x: center.x + axis.x * halfWidth + crossAxis.x * halfHeight, y: center.y + axis.y * halfWidth + crossAxis.y * halfHeight },
        { x: center.x - axis.x * halfWidth + crossAxis.x * halfHeight, y: center.y - axis.y * halfWidth + crossAxis.y * halfHeight }
      ];
    }

    function updateModeButtons(shot) {
      const mode = shot.adjustMode || "corners";
      adjustmentModes.forEach(([buttonId, buttonMode]) => {
        const button = $("#" + buttonId);
        button.classList.toggle("active", mode === buttonMode);
        button.setAttribute("aria-pressed", String(mode === buttonMode));
      });
      $("#reviewHint").textContent = mode === "film"
        ? "Adjust the four film-edge dots. Drag the centerline between them to move the 3:2 crop along the film edges; use the square handle to resize."
        : mode === "rectangle"
          ? "Drag the top-left and bottom-right handles to size and rotate a 3:2 crop."
          : "Drag each crop corner independently to straighten and frame this shot.";
    }

    function renderReview() {
      const shot = activeShot();
      $("#reviewEmpty").classList.toggle("hidden", Boolean(shot));
      $("#reviewContent").classList.toggle("hidden", !shot);
      $("#reviewNegativeToggle").disabled = !shot;
      if (!shot) $("#reviewNegativeToggle").checked = false;
      $("#reviewCorrectionBody").classList.toggle("hidden", !shot || !$("#reviewNegativeToggle").checked);
      updatePreviewFilter();
      $("#previousShotButton").disabled = !shot || activeRoll().shots.length < 2;
      $("#nextShotButton").disabled = !shot || activeRoll().shots.length < 2;
      if (!shot) { $("#reviewShot").textContent = "—"; return; }
      $("#reviewShot").textContent = pad(shot.number);
      $("#flipXToggle").checked = Boolean(shot.flipX);
      $("#flipYToggle").checked = Boolean(shot.flipY);
      shot.adjustMode ||= "rectangle";
      updateModeButtons(shot);
      if (shot.adjustMode === "film") {
        const geometry = filmGeometry(shot);
        if (geometry) shot.quad = filmCropCorners(geometry);
      } else if (shot.adjustMode === "rectangle") {
        shot.quad = rectangleFromQuad(shot);
      }
      drawReview();
    }

    function drawReview() {
      const shot = activeShot();
      if (!shot) return;
      const rect = $("#reviewStage").getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvasWidth = Math.max(1, Math.round(rect.width * dpr));
      const canvasHeight = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const scale = Math.min(rect.width / shot.width, rect.height / shot.height);
      const displayWidth = shot.width * scale;
      const displayHeight = shot.height * scale;
      const offsetX = (rect.width - displayWidth) / 2;
      const offsetY = (rect.height - displayHeight) / 2;
      if (sourceShot !== shot) {
        if (sourceCanvas.width !== shot.width || sourceCanvas.height !== shot.height) {
          sourceCanvas.width = shot.width;
          sourceCanvas.height = shot.height;
        }
        sourceCanvas.getContext("2d", { willReadFrequently: true }).putImageData(new ImageData(shot.pixels, shot.width, shot.height), 0, 0);
        sourceShot = shot;
      }
      context.fillStyle = "#080a09";
      context.fillRect(0, 0, rect.width, rect.height);
      let imageCanvas = sourceCanvas;
      if ($("#reviewNegativeToggle").checked) {
        const previewScale = Math.min(1, 1280 / shot.width, 900 / shot.height);
        const previewWidth = Math.max(1, Math.round(shot.width * previewScale));
        const previewHeight = Math.max(1, Math.round(shot.height * previewScale));
        const previewKey = JSON.stringify([state.rollIndex, shot.number, state.livePreviewAdjustments, previewWidth, previewHeight]);
        if (processedPreviewShot !== shot || processedPreviewKey !== previewKey) {
          processedPreviewCanvas = document.createElement("canvas");
          processedPreviewCanvas.width = previewWidth;
          processedPreviewCanvas.height = previewHeight;
          const previewContext = processedPreviewCanvas.getContext("2d", { willReadFrequently: true });
          previewContext.drawImage(sourceCanvas, 0, 0, previewWidth, previewHeight);
          const previewImage = previewContext.getImageData(0, 0, previewWidth, previewHeight);
          applyPreviewAdjustments(previewImage.data);
          previewContext.putImageData(previewImage, 0, 0);
          processedPreviewShot = shot;
          processedPreviewKey = previewKey;
        }
        imageCanvas = processedPreviewCanvas;
      }
      context.drawImage(imageCanvas, offsetX, offsetY, displayWidth, displayHeight);
      const points = shot.quad.map(({ x, y }) => ({ x: offsetX + x * scale, y: offsetY + y * scale }));
      context.beginPath();
      context.rect(offsetX, offsetY, displayWidth, displayHeight);
      context.moveTo(points[0].x, points[0].y);
      points.slice(1).forEach(({ x, y }) => context.lineTo(x, y));
      context.closePath();
      context.fillStyle = "rgba(0,0,0,.52)";
      context.fill("evenodd");
      context.beginPath();
      context.moveTo(points[0].x, points[0].y);
      points.slice(1).forEach(({ x, y }) => context.lineTo(x, y));
      context.closePath();
      context.strokeStyle = "#d8ff73";
      context.lineWidth = 1.5;
      context.stroke();
      if (shot.adjustMode === "film") {
        const geometry = filmGeometry(shot);
        if (!geometry) return;
        shot.quad = filmCropCorners(geometry);
        const displayGuides = geometry.guides.map(({ x, y }) => ({ x: offsetX + x * scale, y: offsetY + y * scale }));
        const displayCrop = shot.quad.map(({ x, y }) => ({ x: offsetX + x * scale, y: offsetY + y * scale }));
        const center = { x: offsetX + geometry.center.x * scale, y: offsetY + geometry.center.y * scale };
        const centerLineStart = { x: offsetX + geometry.centerLineStart.x * scale, y: offsetY + geometry.centerLineStart.y * scale };
        const centerLineEnd = { x: offsetX + geometry.centerLineEnd.x * scale, y: offsetY + geometry.centerLineEnd.y * scale };
        const resizeHandle = {
          x: center.x + geometry.axis.x * geometry.halfWidth * scale,
          y: center.y + geometry.axis.y * geometry.halfWidth * scale
        };
        context.save();
        context.setLineDash([7, 5]);
        context.strokeStyle = "#6bd9c7";
        context.lineWidth = 1.5;
        context.beginPath();
        context.moveTo(displayGuides[0].x, displayGuides[0].y);
        context.lineTo(displayGuides[1].x, displayGuides[1].y);
        context.moveTo(displayGuides[2].x, displayGuides[2].y);
        context.lineTo(displayGuides[3].x, displayGuides[3].y);
        context.stroke();
        context.setLineDash([3, 5]);
        context.strokeStyle = "#ff9d00";
        context.beginPath();
        context.moveTo(centerLineStart.x, centerLineStart.y);
        context.lineTo(centerLineEnd.x, centerLineEnd.y);
        context.stroke();
        context.restore();
        context.beginPath();
        context.moveTo(displayCrop[0].x, displayCrop[0].y);
        displayCrop.slice(1).forEach(({ x, y }) => context.lineTo(x, y));
        context.closePath();
        context.strokeStyle = "#d8ff73";
        context.lineWidth = 2;
        context.stroke();
        context.fillStyle = "#ff846d";
        displayGuides.forEach(({ x, y }, index) => {
          context.beginPath();
          context.arc(x, y, 6, 0, Math.PI * 2);
          context.fill();
          context.fillStyle = "#111";
          context.font = "9px sans-serif";
          context.fillText(String(index + 1), x - 2.5, y + 3);
          context.fillStyle = "#ff846d";
        });
        context.fillStyle = "#d8ff73";
        context.fillRect(resizeHandle.x - 6, resizeHandle.y - 6, 12, 12);
        context.beginPath();
        context.arc(center.x, center.y, 4, 0, Math.PI * 2);
        context.fill();
        state.cropDisplay = {
          mode: "film", scale, offsetX, offsetY, displayWidth, displayHeight, points: displayCrop,
          guides: displayGuides, centerLineStart, centerLineEnd, resizeHandle, geometry
        };
      } else if (shot.adjustMode === "rectangle") {
        const handles = [points[0], points[2]];
        context.fillStyle = "#d8ff73";
        handles.forEach(({ x, y }, index) => {
          context.fillRect(x - 5, y - 5, 10, 10);
          context.fillStyle = "#111";
          context.font = "9px sans-serif";
          context.fillText(String(index + 1), x + 6, y - 6);
          context.fillStyle = "#d8ff73";
        });
        state.cropDisplay = { mode: "rectangle", scale, offsetX, offsetY, displayWidth, displayHeight, points: handles };
      } else {
        context.fillStyle = "rgba(216,255,115,.5)";
        context.beginPath();
        context.moveTo((points[0].x + points[1].x) / 2, (points[0].y + points[1].y) / 2);
        context.lineTo((points[2].x + points[3].x) / 2, (points[2].y + points[3].y) / 2);
        context.moveTo((points[1].x + points[2].x) / 2, (points[1].y + points[2].y) / 2);
        context.lineTo((points[3].x + points[0].x) / 2, (points[3].y + points[0].y) / 2);
        context.stroke();
        context.fillStyle = "#d8ff73";
        points.forEach(({ x, y }, index) => {
          context.fillRect(x - 4.5, y - 4.5, 9, 9);
          context.fillStyle = "#111";
          context.font = "9px sans-serif";
          context.fillText(String(index + 1), x + 5, y - 5);
          context.fillStyle = "#d8ff73";
        });
        state.cropDisplay = { mode: "corners", scale, offsetX, offsetY, displayWidth, displayHeight, points };
      }
    }

    function pointerToImage(event) {
      const bounds = canvas.getBoundingClientRect();
      const pointX = event.clientX - bounds.left;
      const pointY = event.clientY - bounds.top;
      const display = state.cropDisplay;
      const shot = activeShot();
      return {
        x: clamp((pointX - display.offsetX) / display.scale, 0, shot.width),
        y: clamp((pointY - display.offsetY) / display.scale, 0, shot.height),
        pointX,
        pointY
      };
    }

    function cropHandle(pointX, pointY, display) {
      let nearest = -1;
      let nearestDistance = 16;
      display.points.forEach((point, index) => {
        const distance = Math.hypot(pointX - point.x, pointY - point.y);
        if (distance < nearestDistance) { nearest = index; nearestDistance = distance; }
      });
      return nearest;
    }

    function cornerRegion(point, corners) {
      const topMid = midpoint(corners[0], corners[1]);
      const bottomMid = midpoint(corners[3], corners[2]);
      const leftMid = midpoint(corners[0], corners[3]);
      const rightMid = midpoint(corners[1], corners[2]);
      const center = corners.reduce((sum, corner) => ({ x: sum.x + corner.x / 4, y: sum.y + corner.y / 4 }), { x: 0, y: 0 });
      const vertical = { x: bottomMid.x - topMid.x, y: bottomMid.y - topMid.y };
      const horizontal = { x: rightMid.x - leftMid.x, y: rightMid.y - leftMid.y };
      const right = (point.x - center.x) * horizontal.x + (point.y - center.y) * horizontal.y >= 0;
      const bottom = (point.x - center.x) * vertical.x + (point.y - center.y) * vertical.y >= 0;
      return bottom ? right ? 2 : 3 : right ? 1 : 0;
    }

    function distanceToSegment(point, start, end) {
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const lengthSquared = dx * dx + dy * dy;
      const amount = lengthSquared
        ? clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1)
        : 0;
      return Math.hypot(point.x - (start.x + dx * amount), point.y - (start.y + dy * amount));
    }

    function setFilmMode(shot) {
      shot.adjustMode = "film";
      const geometry = filmGeometry(shot);
      if (geometry) shot.quad = filmCropCorners(geometry);
      updateModeButtons(shot);
      drawReview();
    }

    function setRectangleMode(shot) {
      shot.quad = rectangleFromQuad(shot);
      shot.adjustMode = "rectangle";
      updateModeButtons(shot);
      drawReview();
    }

    function isValidQuad(points) {
      const crossProducts = points.map((point, index) => {
        const next = points[(index + 1) % 4];
        const after = points[(index + 2) % 4];
        return (next.x - point.x) * (after.y - next.y) - (next.y - point.y) * (after.x - next.x);
      });
      const allPositive = crossProducts.every((value) => value > 1);
      const allNegative = crossProducts.every((value) => value < -1);
      return (allPositive || allNegative) && Math.abs(crossProducts.reduce((sum, value) => sum + value, 0)) > 200;
    }

    canvas.addEventListener("pointerdown", (event) => {
      const display = state.cropDisplay;
      const shot = activeShot();
      if (!display || !shot) return;
      const point = pointerToImage(event);
      if (display.mode === "film") {
        let guideHandle = -1;
        let guideDistance = 18;
        display.guides.forEach((guide, index) => {
          const distance = Math.hypot(point.pointX - guide.x, point.pointY - guide.y);
          if (distance < guideDistance) { guideHandle = index; guideDistance = distance; }
        });
        const centerLineDistance = distanceToSegment(
          { x: point.pointX, y: point.pointY },
          display.centerLineStart,
          display.centerLineEnd
        );
        if (guideHandle >= 0) state.drag = { kind: "guide", handle: guideHandle };
        else if (Math.hypot(point.pointX - display.resizeHandle.x, point.pointY - display.resizeHandle.y) < 20) state.drag = { kind: "resize" };
        else if (centerLineDistance < 14) state.drag = { kind: "center" };
        else return;
        canvas.setPointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }
      const insideImage = point.pointX >= display.offsetX &&
        point.pointX <= display.offsetX + display.displayWidth &&
        point.pointY >= display.offsetY &&
        point.pointY <= display.offsetY + display.displayHeight;
      if (!insideImage) return;
      if (display.mode === "rectangle") {
        const handle = cropHandle(point.pointX, point.pointY, display);
        if (handle < 0) return;
        state.drag = { kind: "rectangle", handle };
        canvas.setPointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }
      const handle = cropHandle(point.pointX, point.pointY, display);
      const selectedCorner = handle >= 0 ? handle : cornerRegion(point, shot.quad);
      state.drag = { kind: "corner", handle: selectedCorner };
      const adjusted = shot.quad.map(({ x, y }) => ({ x, y }));
      adjusted[selectedCorner] = { x: point.x, y: point.y };
      if (isValidQuad(adjusted)) shot.quad = adjusted;
      drawReview();
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    canvas.addEventListener("pointermove", (event) => {
      const shot = activeShot();
      if (!state.drag || !shot) return;
      const point = pointerToImage(event);
      if (state.drag.kind === "guide") {
        shot.filmGuides[state.drag.handle] = { x: point.x, y: point.y };
        const geometry = filmGeometry(shot);
        if (geometry) shot.quad = filmCropCorners(geometry);
        drawReview();
        return;
      }
      if (state.drag.kind === "center" || state.drag.kind === "resize") {
        const geometry = filmGeometry(shot);
        if (!geometry) return;
        if (state.drag.kind === "center") {
          const minimumT = Math.min(.49, geometry.halfWidth / geometry.railLength);
          const alongRail = (point.x - geometry.railMid.x) * geometry.axis.x +
            (point.y - geometry.railMid.y) * geometry.axis.y;
          shot.filmCrop.centerT = clamp(.5 + alongRail / geometry.railLength, minimumT, 1 - minimumT);
        } else {
          const dx = point.x - geometry.center.x;
          const dy = point.y - geometry.center.y;
          const width = 2 * (dx * geometry.axis.x + dy * geometry.axis.y);
          shot.filmCrop.width = clamp(width, Math.min(geometry.maxWidth, Math.min(shot.width, shot.height) * .1), geometry.maxWidth);
        }
        const updated = filmGeometry(shot);
        if (updated) shot.quad = filmCropCorners(updated);
        drawReview();
        return;
      }
      if (state.drag.kind === "rectangle") {
        const rectangle = dragRectangleCorner(shot, state.drag.handle, point);
        if (rectangle) shot.quad = rectangle;
        drawReview();
        return;
      }
      const adjusted = shot.quad.map(({ x, y }) => ({ x, y }));
      adjusted[state.drag.handle] = { x: point.x, y: point.y };
      if (isValidQuad(adjusted)) shot.quad = adjusted;
      drawReview();
    });
    const stopCropDrag = () => {
      const shot = activeShot();
      if (state.drag?.kind === "corner" && shot && shot.quad?.length === 4) {
        shot.quad = canonicalQuad(shot.quad);
        drawReview();
      }
      state.drag = null;
    };
    canvas.addEventListener("pointerup", stopCropDrag);
    canvas.addEventListener("pointercancel", stopCropDrag);
    $("#autoCropButton").addEventListener("click", () => {
      const shot = activeShot();
      if (!shot) return;
      if (shot.adjustMode === "film") {
        shot.filmGuides = shot.autoFilmGuides?.map(({ x, y }) => ({ x, y })) || null;
        shot.filmCrop = null;
        setFilmMode(shot);
      } else {
        shot.quad = shot.autoQuad.map(({ x, y }) => ({ x, y }));
        if (shot.adjustMode === "rectangle") shot.quad = rectangleFromQuad(shot);
      }
      drawReview();
    });
    adjustmentModes.forEach(([buttonId, mode]) => {
      $("#" + buttonId).addEventListener("click", () => {
        const shot = activeShot();
        if (!shot) return;
        if (mode === "film") setFilmMode(shot);
        else if (mode === "rectangle") setRectangleMode(shot);
        else {
          shot.adjustMode = "corners";
          updateModeButtons(shot);
          drawReview();
        }
      });
    });
    [["flipXToggle", "flipX"], ["flipYToggle", "flipY"]].forEach(([toggleId, property]) => {
      $("#" + toggleId).addEventListener("change", (event) => {
        const shot = activeShot();
        if (shot) {
          shot[property] = event.target.checked;
          renderFilmList();
        }
      });
    });
    $("#reviewNegativeToggle").addEventListener("change", () => {
      updatePreviewFilter();
      drawReview();
    });
    $("#removeShotButton").addEventListener("click", () => {
      const roll = activeRoll();
      if (!roll.shots.length) return;
      roll.shots.splice(state.selectedShotIndex, 1);
      roll.shots.forEach((shot, index) => { shot.number = index + 1; shot.thumbnail = makeThumbnail(shot); });
      state.selectedShotIndex = clamp(state.selectedShotIndex, 0, Math.max(0, roll.shots.length - 1));
      updateCounts();
      renderReview();
      notify("Frame removed from this roll.");
    });
    $("#previousShotButton").addEventListener("click", () => {
      state.selectedShotIndex = (state.selectedShotIndex - 1 + activeRoll().shots.length) % activeRoll().shots.length;
      renderReview();
      renderFilmList();
    });
    $("#nextShotButton").addEventListener("click", () => {
      state.selectedShotIndex = (state.selectedShotIndex + 1) % activeRoll().shots.length;
      renderReview();
      renderFilmList();
    });
    $("#processBackButton").addEventListener("click", () => setMode("review"));
    window.addEventListener("resize", () => { if (state.mode === "review") drawReview(); });

    return { renderReview };
  };
})();
