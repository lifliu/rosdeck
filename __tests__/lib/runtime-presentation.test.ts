import {
  AUTONOMY_MODE,
  AUTONOMY_PHASE,
  type AutonomyRuntimeStatus,
} from '../../lib/autonomy-runtime';
import { resolveHomeModeKey } from '../../lib/runtime-presentation';

const runtime = (
  mode: number,
  phase: number = AUTONOMY_PHASE.READY,
): AutonomyRuntimeStatus => ({
  stamp: null,
  desired_mode: mode,
  mode,
  phase,
  slam_state: 0,
  planner_state: 0,
  route_recording_state: 0,
  ready: phase === AUTONOMY_PHASE.READY,
  mission_active: false,
  manager_epoch: 'epoch-1',
  runtime_generation: 1,
  status_sequence: 1,
  operation_id: '',
  request_id: '',
  request_sequence: 0,
  request_source: '',
  map_id: '',
  map_version: 0,
  map_checksum: '',
  reason_code: 0,
  reason_text: '',
  route_id: '',
  route_point_count: 0,
  route_distance_m: 0,
  route_checksum: '',
  route_has_unsaved_data: false,
  recording_operation_id: '',
});

const resolve = (
  value: AutonomyRuntimeStatus | null,
  overrides: Partial<Parameters<typeof resolveHomeModeKey>[0]> = {},
) => resolveHomeModeKey({
  runtime: value,
  runtimeStale: false,
  demo: false,
  activeMission: false,
  appOwnsBaseControl: false,
  ...overrides,
});

describe('resolveHomeModeKey', () => {
  it('distinguishes idle from actual APP manual control', () => {
    expect(resolve(runtime(AUTONOMY_MODE.IDLE))).toBe('home.modeIdle');
    expect(resolve(runtime(AUTONOMY_MODE.IDLE), { appOwnsBaseControl: true }))
      .toBe('home.modeManual');
  });

  it('keeps inspection-ready distinct from an active inspection', () => {
    const value = runtime(AUTONOMY_MODE.INSPECTION_READY);
    expect(resolve(value)).toBe('home.modeInspectionReady');
    expect(resolve(value, { activeMission: true })).toBe('home.modeMission');
  });

  it.each([
    [AUTONOMY_MODE.MAPPING, 'home.modeMapping'],
    [AUTONOMY_MODE.LOCALIZATION_READY, 'home.modeLocalization'],
    [AUTONOMY_MODE.SINGLE_POINT_READY, 'home.modeNavigation'],
    [AUTONOMY_MODE.ROUTE_RECORDING, 'home.modeRouteRecording'],
  ] as const)('maps runtime mode %d', (mode, key) => {
    expect(resolve(runtime(mode))).toBe(key);
  });

  it('fails closed for stale, transitional, and error snapshots', () => {
    expect(resolve(null)).toBe('home.modeUnknown');
    expect(resolve(runtime(AUTONOMY_MODE.IDLE), { runtimeStale: true }))
      .toBe('home.modeUnknown');
    expect(resolve(runtime(AUTONOMY_MODE.IDLE, AUTONOMY_PHASE.STARTING)))
      .toBe('home.modeTransitioning');
    expect(resolve(runtime(AUTONOMY_MODE.IDLE, AUTONOMY_PHASE.ERROR)))
      .toBe('home.modeError');
  });
});
