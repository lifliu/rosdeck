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
    pendingDispatch: null,
    dispatching: false,
    controlling: false,
    lastError: null,
  });
}

function status(overrides: Partial<MissionStatusMessage> = {}): MissionStatusMessage {
  return {
    state: MISSION_STATE.EXECUTING,
    mission_id: 'm1',
    request_id: 'req-1',
    sequence: 1,
    route_id: 'route-a',
    map_id: '',
    map_version: '',
    progress: 0,
    reason_code: 0,
    reason_text: '',
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
});

describe('onStatus pendingDispatch rules', () => {
  const seed = () =>
    useMissionStore.getState().setPendingDispatch({
      requestId: 'req-1',
      routeId: 'route-a',
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
});

describe('resetFeed', () => {
  it('drops feed state but keeps lastError', () => {
    const store = useMissionStore.getState();
    store.setRoutes([{ routeId: 'a', mapId: 'm', frameId: '', createdAt: '' }]);
    store.selectRoute('a');
    store.setPendingDispatch({ requestId: 'r', routeId: 'a' });
    store.setDispatching(true);
    store.setControlling(true);
    store.setError('boom');
    store.onEvent(event(1));

    useMissionStore.getState().resetFeed();

    const after = useMissionStore.getState();
    expect(after.status).toBeNull();
    expect(after.events).toEqual([]);
    expect(after.robotStrip).toBeNull();
    expect(after.pendingDispatch).toBeNull();
    expect(after.dispatching).toBe(false);
    expect(after.controlling).toBe(false);
    expect(after.lastError).toBe('boom');
    // route list is not part of the live feed
    expect(after.routes).toHaveLength(1);
    expect(after.selectedRouteId).toBe('a');
  });
});