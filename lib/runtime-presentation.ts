import {
  AUTONOMY_MODE,
  AUTONOMY_PHASE,
  type AutonomyRuntimeStatus,
} from './autonomy-runtime';
import type { ProductCopyKey } from './product-copy';

export interface HomeModeContext {
  runtime: AutonomyRuntimeStatus | null;
  runtimeStale: boolean;
  demo: boolean;
  activeMission: boolean;
  appOwnsBaseControl: boolean;
}

/**
 * 把 Mission Manager 的权威运行模式映射为首页文案键。
 *
 * “没有巡检任务”不等于“手动控制”；只有 APP 实际持有基础控制租约时才显示
 * 手动模式。巡检运行时在任务终态后仍可保持就绪，此时显示“巡检待命”。
 */
export function resolveHomeModeKey(context: HomeModeContext): ProductCopyKey {
  const { runtime, runtimeStale, demo, activeMission, appOwnsBaseControl } = context;
  if (demo) return 'home.modeManual';
  if (!runtime || runtimeStale) return 'home.modeUnknown';
  if (
    runtime.phase === AUTONOMY_PHASE.STARTING ||
    runtime.phase === AUTONOMY_PHASE.SWITCHING ||
    runtime.phase === AUTONOMY_PHASE.STOPPING
  ) {
    return 'home.modeTransitioning';
  }
  if (
    runtime.phase === AUTONOMY_PHASE.ERROR ||
    runtime.phase === AUTONOMY_PHASE.CONFLICT
  ) {
    return 'home.modeError';
  }
  switch (runtime.mode) {
    case AUTONOMY_MODE.MAPPING:
      return 'home.modeMapping';
    case AUTONOMY_MODE.LOCALIZATION_READY:
      return 'home.modeLocalization';
    case AUTONOMY_MODE.SINGLE_POINT_READY:
      return 'home.modeNavigation';
    case AUTONOMY_MODE.INSPECTION_READY:
      return activeMission ? 'home.modeMission' : 'home.modeInspectionReady';
    case AUTONOMY_MODE.ROUTE_RECORDING:
      return 'home.modeRouteRecording';
    case AUTONOMY_MODE.IDLE:
    default:
      return appOwnsBaseControl ? 'home.modeManual' : 'home.modeIdle';
  }
}
