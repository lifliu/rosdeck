import fs from 'node:fs';
import path from 'node:path';
import {
  ROUTE_RECORDING_DISPOSITION,
  generateRouteId,
} from '../../lib/autonomy-runtime';

describe('RouteRecordingControl contract', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../components/RouteRecordingControl.tsx'),
    'utf8',
  );

  it('uses Mission mode and explicit save/discard services', () => {
    expect(source).toContain('AUTONOMY_MODE.ROUTE_RECORDING');
    expect(source).toContain('setAutonomyMode');
    expect(source).toContain('finishRouteRecording');
    expect(source).toContain('runtimeStore.routeRecordingOperationId');
    expect(ROUTE_RECORDING_DISPOSITION).toEqual({ SAVE: 1, DISCARD: 2 });
    expect(source).not.toContain('/rosdeck/');
  });

  it('shows authoritative map binding and unsaved route metrics', () => {
    expect(source).toContain('runtime?.route_has_unsaved_data');
    expect(source).toContain('runtime.route_point_count');
    expect(source).toContain('runtime.route_distance_m');
    expect(source).toContain('mapChecksum: selectedMap.mapChecksum');
    expect(source).toContain("t('routeRecording.activeRoute'");
    expect(source).toContain('phase === AUTONOMY_PHASE.ERROR');
  });

  it('offers finish as soon as Manager publishes the recording session identity', () => {
    expect(source).toContain('const recordingSessionActive = Boolean(recordingOperationId)');
    expect(source).toContain('recording || recordingStarting');
    expect(source).toContain('!recordingSessionActive');
    expect(source).toContain("t('routeRecording.recording'");
  });

  it('requires a fresh catalog selection when runtime has no map identity', () => {
    expect(source).toContain('<MapCatalogPicker');
    expect(source).toContain('setMapPickerOpen(true)');
    expect(source).toContain('setSelectedMap(entry)');
    expect(source).toContain('每次新建录制会话都查询机器人目录');
    expect(source).toContain('mapVersion: selectedMap.mapVersion');
    expect(source).not.toContain('/omni/slam/maps/list');
  });

  it('generates a path-safe default route id', () => {
    expect(generateRouteId(new Date('2026-09-06T12:34:56.789Z')))
      .toBe('route-20260906T123456789Z');
  });

  it('scrolls and avoids the keyboard on short landscape screens', () => {
    expect(source).toContain('<KeyboardAvoidingView');
    expect(source).toContain('<ScrollView');
    expect(source).toContain('keyboardShouldPersistTaps="handled"');
    expect(source).toContain("maxHeight: '94%'");
  });
});
