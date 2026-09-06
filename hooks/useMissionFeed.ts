import { useEffect } from 'react';
import {
  MISSION_EVENTS_TOPIC,
  MISSION_EVENTS_TYPE,
  MISSION_STATUS_TOPIC,
  MISSION_STATUS_TYPE,
  ROBOT_STATE_TOPIC,
  ROBOT_STATE_TYPE,
} from '../lib/mission/api';
import { useMissionStore } from '../stores/useMissionStore';
import { useRosStore } from '../stores/useRosStore';

// MissionStatus 与 RobotState 都是 1 Hz heartbeat；3.5 秒允许短暂调度抖动，
// 又能在 provider 中断时快于一次人工操作收紧界面门禁。
export const MISSION_FEED_STALE_MS = 3500;

export interface MissionFeedWatchdog {
  armMissionStatus: () => void;
  armRobotState: () => void;
  dispose: () => void;
}

/**
 * 为两条独立心跳维护过期计时器。
 *
 * MissionStatus 与 RobotState 可能由不同节点发布，任一路中断都必须单独
 * 收紧其对应门禁，不能因为另一条心跳仍在更新就沿用旧的安全状态。
 */
export function createMissionFeedWatchdog(
  onMissionStatusStale: () => void,
  onRobotStateStale: () => void,
  staleMs = MISSION_FEED_STALE_MS,
): MissionFeedWatchdog {
  let missionStatusTimer: ReturnType<typeof setTimeout> | null = null;
  let robotStateTimer: ReturnType<typeof setTimeout> | null = null;

  const replaceTimer = (
    timer: ReturnType<typeof setTimeout> | null,
    callback: () => void,
  ) => {
    if (timer) clearTimeout(timer);
    return setTimeout(callback, staleMs);
  };

  return {
    armMissionStatus: () => {
      missionStatusTimer = replaceTimer(
        missionStatusTimer,
        onMissionStatusStale,
      );
    },
    armRobotState: () => {
      robotStateTimer = replaceTimer(robotStateTimer, onRobotStateStale);
    },
    dispose: () => {
      if (missionStatusTimer) clearTimeout(missionStatusTimer);
      if (robotStateTimer) clearTimeout(robotStateTimer);
      missionStatusTimer = null;
      robotStateTimer = null;
    },
  };
}

/**
 * 在应用根层维护唯一的 Mission/Robot 实时订阅。
 *
 * Tab 页面会被导航器缓存；如果每个页面各自订阅，访问过多个 Tab 后，同一条
 * MissionEvent 会被重复写入 Store，切页卸载时还会错误清空其他页面依赖的状态。
 */
export function useMissionFeed(): void {
  const connectionStatus = useRosStore((state) => state.connection.status);
  const transport = useRosStore((state) => state.transport);
  const url = useRosStore((state) => state.connection.url);

  useEffect(() => {
    if (
      connectionStatus !== 'connected' ||
      !transport ||
      url.startsWith('demo://')
    ) {
      useMissionStore.getState().resetFeed();
      return;
    }

    const watchdog = createMissionFeedWatchdog(
      () => useMissionStore.getState().markMissionStatusStale(),
      () => useMissionStore.getState().markRobotStateStale(),
    );

    const subscriptions = [
      transport.subscribe(
        MISSION_STATUS_TOPIC,
        MISSION_STATUS_TYPE,
        (message) => {
          useMissionStore.getState().onStatus(message);
          watchdog.armMissionStatus();
        },
      ),
      transport.subscribe(
        MISSION_EVENTS_TOPIC,
        MISSION_EVENTS_TYPE,
        (message) => useMissionStore.getState().onEvent(message),
      ),
      transport.subscribe(
        ROBOT_STATE_TOPIC,
        ROBOT_STATE_TYPE,
        (message) => {
          useMissionStore.getState().onRobotState(message);
          watchdog.armRobotState();
        },
      ),
    ];

    return () => {
      subscriptions.forEach((subscription) => subscription.unsubscribe());
      watchdog.dispose();
      // transport 更换或断开后，上一台机器人的快照不再可用。
      useMissionStore.getState().resetFeed();
    };
  }, [connectionStatus, transport, url]);
}
