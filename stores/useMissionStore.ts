import { create } from 'zustand';
import {
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

  // in-flight dispatch intent: same (requestId, route) reuses the key, so
  // a retry after a WS flake is an idempotent replay, not a re-dispatch
  pendingDispatch: PendingDispatch | null;
  dispatching: boolean;
  controlling: boolean;
  lastError: string | null;

  setRoutes: (routes: RouteEntry[]) => void;
  selectRoute: (routeId: string | null) => void;
  setPendingDispatch: (pending: PendingDispatch | null) => void;
  setDispatching: (dispatching: boolean) => void;
  setControlling: (controlling: boolean) => void;
  setError: (message: string | null) => void;

  onStatus: (message: MissionStatusMessage) => void;
  onEvent: (message: MissionEventMessage) => void;
  onRobotState: (message: Record<string, unknown>) => void;

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

  pendingDispatch: null,
  dispatching: false,
  controlling: false,
  lastError: null,

  setRoutes: (routes) => set({ routes, routesLoaded: true }),
  selectRoute: (routeId) => set({ selectedRouteId: routeId }),
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
      return { status: message, pendingDispatch: next };
    }),

  onEvent: (message) =>
    set((state) => ({
      events: [message, ...state.events].slice(0, MAX_EVENTS_SHOWN),
    })),

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
    }),

  resetFeed: () =>
    set({
      status: null,
      events: [],
      robotStrip: null,
      pendingDispatch: null,
      dispatching: false,
      controlling: false,
      lastError: get().lastError,
    }),
}));