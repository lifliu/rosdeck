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
    expect(source).not.toContain('/rosdeck/');
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
