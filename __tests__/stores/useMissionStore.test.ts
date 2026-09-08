import { MAX_EVENTS_SHOWN, useMissionStore } from '../../stores/useMissionStore';
import { MISSION_STATE } from '../../lib/mission/types';
import type {
  MissionEventMessage,
  MissionStatusMessage,
} from '../../lib/mission/types';

function resetStore() {
  useMissionStore.setState({
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
  });
}

function status(overrides: Partial<MissionStatusMessage> = {}): MissionStatusMessage {
  return {
    header: {},
    state: MISSION_STATE.EXECUTING,
    mission_id: 'm1',
    request_id: 'req-1',
    sequence: 1,
    route_id: 'route-a',
    map_id: '',
    map_version: '',
    progress: 0,
    current_checkpoint_id: '',
    status_text: '',
    reason_code: 0,
    reason_text: '',
    request_source: 'test-app',
    map_checksum: '',
    route_checksum: '',
    requested_at: {},
    deadline: {},
    ...overrides,
  };
}

function event(sequence: number): MissionEventMessage {
  return {
    mission_id: 'm1',
    sequence,
    event: 0,
    mission_state: MISSION_STATE.EXECUTING,
    progress: 0,
    reason_code: 0,
    reason_text: '',
  };
}

beforeEach(() => {
  resetStore();
});

describe('onEvent', () => {
  it('prepends newest-first', () => {
    useMissionStore.getState().onEvent(event(1));
    useMissionStore.getState().onEvent(event(2));
    expect(useMissionStore.getState().events.map((e) => e.sequence)).toEqual([2, 1]);
  });

  it(`caps the ring at ${MAX_EVENTS_SHOWN} keeping the newest`, () => {
    const push = MAX_EVENTS_SHOWN + 5;
    for (let i = 1; i <= push; i++) {
      useMissionStore.getState().onEvent(event(i));
    }
    const events = useMissionStore.getState().events;
    expect(events).toHaveLength(MAX_EVENTS_SHOWN);
    expect(events[0].sequence).toBe(push);
    expect(events[events.length - 1].sequence).toBe(6);
  });

  it('deduplicates a replayed durable event identity', () => {
    useMissionStore.getState().onEvent(event(7));
    useMissionStore.getState().onEvent({ ...event(7), reason_text: 'replayed' });

    expect(useMissionStore.getState().events).toEqual([
      expect.objectContaining({ sequence: 7, reason_text: 'replayed' }),
    ]);
  });
});

describe('route selection safety', () => {
  const validRoute = {
    routeId: 'route-a', mapId: 'map-a', frameId: 'omni_map', createdAt: '',
    mapVersion: '1', mapChecksum: 'a'.repeat(64), routeChecksum: 'digest',
    pointCount: 3, distanceM: 2.5,
  };

  it('does not select a legacy route without an exact map checksum', () => {
    useMissionStore.getState().setRoutes([
      { ...validRoute, mapChecksum: '' },
    ]);
    useMissionStore.getState().selectRoute('route-a');
    expect(useMissionStore.getState().selectedRouteId).toBeNull();
  });

  it('clears selection when a refreshed asset becomes non-dispatchable', () => {
    useMissionStore.getState().setRoutes([validRoute]);
    useMissionStore.getState().selectRoute('route-a');
    expect(useMissionStore.getState().selectedRouteId).toBe('route-a');

    useMissionStore.getState().setRoutes([
      { ...validRoute, mapChecksum: '' },
    ]);
    expect(useMissionStore.getState().selectedRouteId).toBeNull();
  });

  it('clears the previous robot catalog before requesting a fresh snapshot', () => {
    useMissionStore.getState().setRoutes([validRoute]);
    useMissionStore.getState().selectRoute('route-a');

    useMissionStore.getState().beginRoutesRefresh();

    const state = useMissionStore.getState();
    expect(state.routes).toEqual([]);
    expect(state.routesLoaded).toBe(false);
    expect(state.selectedRouteId).toBeNull();
  });
});

describe('onStatus pendingDispatch rules', () => {
  const seed = () =>
    useMissionStore.getState().setPendingDispatch({
      requestId: 'req-1',
      routeId: 'route-a',
      sequence: 1,
      source: 'test-app',
      requestedAt: { sec: 1, nanosec: 0 },
      deadline: { sec: 31, nanosec: 0 },
    });

  it('keeps the intent for the same request_id (replay across a reconnect)', () => {
    seed();
    useMissionStore.getState().onStatus(status({ request_id: 'req-1' }));
    expect(useMissionStore.getState().pendingDispatch?.requestId).toBe('req-1');
  });

  it('clears the intent when a different request takes over', () => {
    seed();
    useMissionStore.getState().onStatus(status({ request_id: 'req-2' }));
    expect(useMissionStore.getState().pendingDispatch).toBeNull();
  });

  it('clears the intent on a NONE row (no mission)', () => {
    seed();
    useMissionStore.getState().onStatus(status({ state: MISSION_STATE.NONE }));
    expect(useMissionStore.getState().pendingDispatch).toBeNull();
  });

  it('marks MissionStatus fresh on receipt and stale on heartbeat timeout', () => {
    useMissionStore.getState().onStatus(status());
    expect(useMissionStore.getState().missionStatusStale).toBe(false);

    useMissionStore.getState().markMissionStatusStale();
    expect(useMissionStore.getState().missionStatusStale).toBe(true);
  });
});

describe('onRobotState', () => {
  it('maps the strip fields and coerces types', () => {
    useMissionStore.getState().onRobotState({
      localization_state: '3',
      map_id: 'map-1',
      map_version: 'v7',
      health_level: 1,
      estop_latched: true,
      mission_state: 2,
      battery_percentage: 87.5,
    });
    expect(useMissionStore.getState().robotStrip).toEqual({
      localization_state: 3,
      map_id: 'map-1',
      map_version: 'v7',
      health_level: 1,
      estop_latched: true,
      mission_state: 2,
      battery_percentage: 87.5,
    });
  });

  it('defaults missing battery to NaN', () => {
    useMissionStore.getState().onRobotState({});
    const strip = useMissionStore.getState().robotStrip;
    expect(Number.isNaN(strip?.battery_percentage)).toBe(true);
    expect(strip?.localization_state).toBe(0);
  });

  it('marks RobotState fresh on receipt and stale on heartbeat timeout', () => {
    useMissionStore.getState().onRobotState({});
    expect(useMissionStore.getState().robotStateStale).toBe(false);

    useMissionStore.getState().markRobotStateStale();
    expect(useMissionStore.getState().robotStateStale).toBe(true);
  });
});

describe('resetFeed', () => {
  it('drops feed state but keeps lastError', () => {
    const store = useMissionStore.getState();
    store.setRoutes([{
      routeId: 'a', mapId: 'm', frameId: 'omni_map', createdAt: '',
      mapVersion: '1', mapChecksum: 'a'.repeat(64), routeChecksum: 'route-sha',
      pointCount: 3, distanceM: 2.5,
    }]);
    store.selectRoute('a');
    store.setPendingDispatch({
      requestId: 'r', routeId: 'a', sequence: 1, source: 'test-app',
      requestedAt: { sec: 1, nanosec: 0 },
      deadline: { sec: 31, nanosec: 0 },
    });
    store.setDispatching(true);
    store.setControlling(true);
    store.setError('boom');
    store.onEvent(event(1));

    useMissionStore.getState().resetFeed();

    const after = useMissionStore.getState();
    expect(after.status).toBeNull();
    expect(after.events).toEqual([]);
    expect(after.robotStrip).toBeNull();
    expect(after.missionStatusStale).toBe(true);
    expect(after.robotStateStale).toBe(true);
    expect(after.pendingDispatch).toBeNull();
    expect(after.dispatching).toBe(false);
    expect(after.controlling).toBe(false);
    expect(after.lastError).toBe('boom');
    // route list is not part of the live feed
    expect(after.routes).toHaveLength(1);
    expect(after.selectedRouteId).toBe('a');
  });
});
