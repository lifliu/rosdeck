export function occupancyToRgba(value: number): [number, number, number, number] {
  if (value < 0) return [105, 105, 105, 255];
  const v = Math.round((value / 100) * 235 + 20);
  return [v, v, v, 255];
}

export function occupancyGridToPixels(data: number[], width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const srcIdx = (height - 1 - row) * width + col;
      const dstIdx = (row * width + col) * 4;
      const [r, g, b, a] = occupancyToRgba(data[srcIdx] ?? -1);
      pixels[dstIdx] = r;
      pixels[dstIdx + 1] = g;
      pixels[dstIdx + 2] = b;
      pixels[dstIdx + 3] = a;
    }
  }
  return pixels;
}

/**
 * Convert costmap occupancy to RGBA with color coding.
 * 0 = free (transparent), 1-98 = blue→red gradient, 99-100 = lethal (magenta), -1 = unknown (transparent)
 */
export function costmapToRgba(value: number, alpha: number = 180): [number, number, number, number] {
  if (value < 0 || value === 0) return [0, 0, 0, 0];
  if (value >= 99) return [200, 0, 200, alpha];
  const t = value / 100;
  const r = Math.round(Math.min(1, t * 2) * 255);
  const g = Math.round(Math.max(0, 1 - Math.abs(t - 0.5) * 2) * 200);
  const b = Math.round(Math.max(0, 1 - t * 2) * 255);
  return [r, g, b, alpha];
}

export function costmapGridToPixels(data: number[], width: number, height: number, alpha: number = 180): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const srcIdx = (height - 1 - row) * width + col;
      const dstIdx = (row * width + col) * 4;
      const [r, g, b, a] = costmapToRgba(data[srcIdx] ?? -1, alpha);
      pixels[dstIdx] = r;
      pixels[dstIdx + 1] = g;
      pixels[dstIdx + 2] = b;
      pixels[dstIdx + 3] = a;
    }
  }
  return pixels;
}

export function gridToWorld(
  gridX: number,
  gridY: number,
  resolution: number,
  origin: { x: number; y: number },
): [number, number] {
  return [origin.x + gridX * resolution, origin.y + gridY * resolution];
}

export function worldToGrid(
  worldX: number,
  worldY: number,
  resolution: number,
  origin: { x: number; y: number },
): [number, number] {
  return [
    Math.round((worldX - origin.x) / resolution),
    Math.round((worldY - origin.y) / resolution),
  ];
}

export function worldToCanvas(
  worldX: number, worldY: number,
  mapInfo: { width: number; height: number; resolution: number; origin: { x: number; y: number } },
  canvasWidth: number, canvasHeight: number,
  fitScale: number, zoom: number, panX: number, panY: number
): [number, number] {
  const gridX = (worldX - mapInfo.origin.x) / mapInfo.resolution;
  const gridY = mapInfo.height - (worldY - mapInfo.origin.y) / mapInfo.resolution;
  const totalScale = fitScale * zoom;
  const offsetX = panX + (canvasWidth - mapInfo.width * totalScale) / 2;
  const offsetY = panY + (canvasHeight - mapInfo.height * totalScale) / 2;
  return [offsetX + gridX * totalScale, offsetY + gridY * totalScale];
}

export function canvasToWorld(
  canvasX: number, canvasY: number,
  mapInfo: { width: number; height: number; resolution: number; origin: { x: number; y: number } },
  canvasWidth: number, canvasHeight: number,
  fitScale: number, zoom: number, panX: number, panY: number
): [number, number] {
  const totalScale = fitScale * zoom;
  const offsetX = panX + (canvasWidth - mapInfo.width * totalScale) / 2;
  const offsetY = panY + (canvasHeight - mapInfo.height * totalScale) / 2;
  const gridX = (canvasX - offsetX) / totalScale;
  const gridY = (canvasY - offsetY) / totalScale;
  const worldX = mapInfo.origin.x + gridX * mapInfo.resolution;
  const worldY = mapInfo.origin.y + (mapInfo.height - gridY) * mapInfo.resolution;
  return [worldX, worldY];
}

/**
 * 将无 OccupancyGrid 的机器人中心视图坐标换算到世界坐标。
 *
 * Mode B 在 Canvas 中使用 `(worldX, -worldY)`，因此纵轴换算必须显式
 * 反向。`center` 是跟随模式下的机器人位置；自由平移模式传入世界原点，
 * 并通过 pan 表达视图偏移。
 */
export function robotCentricCanvasToWorld(
  canvasX: number,
  canvasY: number,
  canvasWidth: number,
  canvasHeight: number,
  pixelsPerMeter: number,
  center: { x: number; y: number },
  panX = 0,
  panY = 0,
): [number, number] {
  if (![canvasX, canvasY, canvasWidth, canvasHeight, pixelsPerMeter,
    center.x, center.y, panX, panY].every(Number.isFinite) ||
      canvasWidth <= 0 || canvasHeight <= 0 || pixelsPerMeter <= 0) {
    throw new Error('Robot-centric viewport requires finite positive dimensions');
  }
  return [
    center.x + (canvasX - canvasWidth / 2 - panX) / pixelsPerMeter,
    center.y - (canvasY - canvasHeight / 2 - panY) / pixelsPerMeter,
  ];
}

/** `robotCentricCanvasToWorld` 的逆变换，供目标标记和单元测试复用。 */
export function robotCentricWorldToCanvas(
  worldX: number,
  worldY: number,
  canvasWidth: number,
  canvasHeight: number,
  pixelsPerMeter: number,
  center: { x: number; y: number },
  panX = 0,
  panY = 0,
): [number, number] {
  if (![worldX, worldY, canvasWidth, canvasHeight, pixelsPerMeter,
    center.x, center.y, panX, panY].every(Number.isFinite) ||
      canvasWidth <= 0 || canvasHeight <= 0 || pixelsPerMeter <= 0) {
    throw new Error('Robot-centric viewport requires finite positive dimensions');
  }
  return [
    canvasWidth / 2 + panX + (worldX - center.x) * pixelsPerMeter,
    canvasHeight / 2 + panY - (worldY - center.y) * pixelsPerMeter,
  ];
}
