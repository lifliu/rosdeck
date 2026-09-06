import { create } from 'zustand';
import type { RosTime } from '../lib/autonomy-runtime';
import {
  getRouteDispatchBlockReason,
  MISSION_STATE,
  type MissionEventMessage,
  type MissionStatusMessage,
  type RobotStateStrip,
  type RouteEntry,
} from '../lib/mission/types';

// /omni/mission/events is a live feed; the page shows a bounded window.
export const MAX_EVENTS_SHOWN = 50;

export interface PendingDispatch {
  requestId: string;
  routeId: string;
  sequence: number;
  source: string;
  requestedAt: RosTime;
  deadline: RosTime;
}

interface MissionStore {
  // route list (/omni/routes/list)
  routes: RouteEntry[];
  routesLoaded: boolean;
  selectedRouteId: string | null;

  // live feed
  status: MissionStatusMessage | null;
  events: MissionEventMessage[]; // newest first, capped at MAX_EVENTS_SHOWN
  robotStrip: RobotStateStrip | null;
  missionStatusStale: boolean;
  robotStateStale: boolean;

  // in-flight dispatch intent: same (requestId, route) reuses the key, so
  // a retry after a WS flake is an idempotent replay, not a re-dispatch
  pendingDispatch: PendingDispatch | null;
  dispatching: boolean;
  controlling: boolean;
  lastError: string | null;

  beginRoutesRefresh: () => void;
  setRoutes: (routes: RouteEntry[]) => void;
  selectRoute: (routeId: string | null) => void;
  setPendingDispatch: (pending: PendingDispatch | null) => void;
  setDispatching: (dispatching: boolean) => void;
  setControlling: (controlling: boolean) => void;
  setError: (message: string | null) => void;

  onStatus: (message: MissionStatusMessage) => void;
  onEvent: (message: MissionEventMessage) => void;
  onRobotState: (message: Record<string, unknown>) => void;
  markMissionStatusStale: () => void;
  markRobotStateStale: () => void;

  // connection dropped: the feed is stale; drop it
  resetFeed: () => void;
}

export const useMissionStore = create<MissionStore>((set, get) => ({
  routes: [],
  routesLoaded: false,
  selectedRouteId: null,

  status: null,
  events: [],
  robotStrip: null,
  missionStatusStale: true,
  robotStateStale: true,

  pendingDispatch: null,
  dispatching: false,
  controlling: false,
  lastError: null,

  beginRoutesRefresh: () => set({
    // 路线属于当前机器人的权威资产目录。重连或切换设备后，在新
    // ListRoutes 快照到达前不得继续展示、选中或派发上一台机器人的路线。
    routes: [],
    routesLoaded: false,
    selectedRouteId: null,
  }),
  setRoutes: (routes) =>
    set((state) => {
      // 路线资产可能在刷新期间被替换或降级；选择状态必须跟随最新快照收敛，
      // 不能让底部派发按钮继续引用已经不可执行的旧条目。
      const selected = routes.find(
        (route) => route.routeId === state.selectedRouteId,
      );
      return {
        routes,
        routesLoaded: true,
        selectedRouteId:
          selected && !getRouteDispatchBlockReason(selected)
            ? state.selectedRouteId
            : null,
      };
    }),
  selectRoute: (routeId) =>
    set((state) => {
      if (!routeId) return { selectedRouteId: null };
      const route = state.routes.find((entry) => entry.routeId === routeId);
      return {
        selectedRouteId:
          route && !getRouteDispatchBlockReason(route) ? routeId : null,
      };
    }),
  setPendingDispatch: (pendingDispatch) => set({ pendingDispatch }),
  setDispatching: (dispatching) => set({ dispatching }),
  setControlling: (controlling) => set({ controlling }),
  setError: (lastError) => set({ lastError }),

  onStatus: (message) =>
    set((state) => {
      // A status for a different request, or a NONE row, ends the pending
      // dispatch intent; the same request_id keeps it alive so a retry
      // after a reconnect replays instead of re-dispatching.
      const pending = state.pendingDispatch;
      let next = pending;
      if (pending) {
        const otherRequest =
          message.request_id !== '' &&
          message.request_id !== pending.requestId;
        if (otherRequest || message.state === MISSION_STATE.NONE) {
          next = null;
        }
      }
      return {
        status: message,
        pendingDispatch: next,
        missionStatusStale: false,
      };
    }),

  onEvent: (message) =>
    set((state) => {
      // (mission_id, sequence) 是 Mission 持久化事件的稳定身份。传输层
      // 重连、重放或短暂重复订阅都不应在时间线里制造重复记录。
      const withoutDuplicate = state.events.filter(
        (event) => event.mission_id !== message.mission_id ||
          event.sequence !== message.sequence,
      );
      return {
        events: [message, ...withoutDuplicate].slice(0, MAX_EVENTS_SHOWN),
      };
    }),

  onRobotState: (message) =>
    set({
      robotStrip: {
        localization_state: Number(message.localization_state ?? 0),
        map_id: String(message.map_id ?? ''),
        map_version: String(message.map_version ?? ''),
        health_level: Number(message.health_level ?? 0),
        estop_latched: message.estop_latched === true,
        mission_state: Number(message.mission_state ?? 0),
        battery_percentage: Number(message.battery_percentage ?? NaN),
      },
      robotStateStale: false,
    }),

  markMissionStatusStale: () => set({ missionStatusStale: true }),
  markRobotStateStale: () => set({ robotStateStale: true }),

  resetFeed: () =>
    set({
      status: null,
      events: [],
      robotStrip: null,
      missionStatusStale: true,
      robotStateStale: true,
      pendingDispatch: null,
      dispatching: false,
      controlling: false,
      lastError: get().lastError,
    }),
}));
