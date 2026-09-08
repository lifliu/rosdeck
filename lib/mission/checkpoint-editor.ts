const POSITION_RATIOS = [0, 0.25, 0.5, 0.75, 1] as const;

export interface RoutePointPreset {
  pointIndex: number;
  percentage: number;
}

/**
 * 为短路线生成不重复的位置快捷键。
 *
 * 例如三点路线若直接对 0/25/50/75/100% 分别取整，会得到 0/1/1/2/2，
 * 导致多个按钮同时高亮。这里先按真实路线点去重，再用真实点位比例生成标签。
 */
export function buildRoutePointPresets(pointCount: number): RoutePointPreset[] {
  if (!Number.isInteger(pointCount) || pointCount < 2) return [];
  const lastPointIndex = pointCount - 1;
  const pointIndexes = Array.from(new Set(
    POSITION_RATIOS.map((ratio) => Math.round(lastPointIndex * ratio)),
  )).sort((left, right) => left - right);
  return pointIndexes.map((pointIndex) => ({
    pointIndex,
    percentage: Math.round((pointIndex / lastPointIndex) * 100),
  }));
}
