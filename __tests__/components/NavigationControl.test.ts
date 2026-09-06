import fs from 'node:fs';
import path from 'node:path';
import { AUTONOMY_MODE } from '../../lib/autonomy-runtime';
import { ACTIVE_MISSION_STATES, MISSION_STATE } from '../../lib/mission/types';

describe('NavigationControl runtime migration', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../components/NavigationControl.tsx'),
    'utf8',
  );

  it('ensures the single-point mode through Mission Manager', () => {
    expect(AUTONOMY_MODE.SINGLE_POINT_READY).toBe(3);
    expect(source).toContain('setAutonomyMode');
    expect(source).toContain('desiredMode: AUTONOMY_MODE.SINGLE_POINT_READY');
    expect(source).toContain('mapVersion: mapIdentity.mapVersion');
    expect(source).toContain('mapChecksum: mapIdentity.mapChecksum');
    expect(source).not.toContain('/rosdeck/');
  });

  it('opens a fresh map catalog when the runtime has no complete identity', () => {
    expect(source).toContain('<MapCatalogPicker');
    expect(source).toContain('setMapPickerOpen(true)');
    expect(source).toContain('requestNavigationMode(entry)');
    expect(source).toContain('即使 runtime 仍保留上一张地图，也重新读取目录');
    expect(source).not.toContain('/omni/slam/maps/list');
    expect(source).not.toContain('/goal_pose');
  });

  it('keeps the catalog reachable while navigation is already ready', () => {
    expect(source).toContain('mapIdentityKey(entry) === mapIdentityKey(currentMapIdentity)');
    expect(source).toMatch(
      /const canEnsureNavigation = synchronized && !transitioning && !runtimeFault &&\s*!missionActive/,
    );
    expect(source).not.toMatch(/canEnsureNavigation[^;]*!navigationReady/);
    expect(source).toContain("'navigation.changeMapButton'");
  });

  it('defines inspection-active UI only from non-terminal MissionStatus states', () => {
    expect(ACTIVE_MISSION_STATES).toEqual([
      MISSION_STATE.PENDING,
      MISSION_STATE.EXECUTING,
      MISSION_STATE.PAUSED,
    ]);
    expect(source).toContain('ACTIVE_MISSION_STATES.includes(missionState)');
    expect(source).not.toContain('runtime?.mission_active');
  });
});
