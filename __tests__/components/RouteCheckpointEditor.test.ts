import fs from 'node:fs';
import path from 'node:path';
import { buildRoutePointPresets } from '../../lib/mission/checkpoint-editor';

describe('RouteCheckpointEditor operational contract', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../components/RouteCheckpointEditor.tsx'),
    'utf8',
  );

  it('loads an authoritative snapshot and saves with optimistic concurrency', () => {
    expect(source).toContain('getRouteCheckpoints(transport, routeId)');
    expect(source).toContain('updateRouteCheckpoints(transport, routeId, plan)');
    expect(source).toContain('乐观并发校验');
    expect(source).not.toContain('AsyncStorage');
  });

  it('keeps the editor session stable while the parent refreshes route objects', () => {
    expect(source).toContain("const routeId = route?.routeId ?? '';");
    expect(source).toContain('[connectionStatus, routeId, transport, zh]');
    expect(source).not.toContain('[connectionStatus, route, transport, zh]');
    expect(source).toContain('close();\n      await onSaved();');
  });

  it('supports every executable checkpoint action and stable ordering', () => {
    expect(source).toContain('ROUTE_CHECKPOINT_ACTION_TYPE.DWELL');
    expect(source).toContain('ROUTE_CHECKPOINT_ACTION_TYPE.PHOTO');
    expect(source).toContain('ROUTE_CHECKPOINT_ACTION_TYPE.RECORD');
    expect(source).toContain('ROUTE_CHECKPOINT_ACTION_TYPE.RECOGNIZE');
    expect(source).toContain('[actions[actionIndex - 1], actions[actionIndex]]');
  });

  it('keeps fields and save controls reachable on a short landscape phone', () => {
    expect(source).toContain('<KeyboardAvoidingView');
    expect(source).toContain('<ScrollView');
    expect(source).toContain('height: \'94%\'');
    expect(source).toContain('keyboardShouldPersistTaps="handled"');
  });

  it('supports both coarse stepping and direct one-based point entry', () => {
    expect(source).toContain('路线点序号');
    expect(source).toContain('oneBasedPoint - 1');
    expect(source).toContain('[-10, -1]');
    expect(source).toContain('[1, 10]');
  });

  it('deduplicates percentage presets on short routes', () => {
    expect(buildRoutePointPresets(2)).toEqual([
      { pointIndex: 0, percentage: 0 },
      { pointIndex: 1, percentage: 100 },
    ]);
    expect(buildRoutePointPresets(3)).toEqual([
      { pointIndex: 0, percentage: 0 },
      { pointIndex: 1, percentage: 50 },
      { pointIndex: 2, percentage: 100 },
    ]);
    expect(buildRoutePointPresets(5)).toEqual([
      { pointIndex: 0, percentage: 0 },
      { pointIndex: 1, percentage: 25 },
      { pointIndex: 2, percentage: 50 },
      { pointIndex: 3, percentage: 75 },
      { pointIndex: 4, percentage: 100 },
    ]);
  });
});
