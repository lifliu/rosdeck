import fs from 'node:fs';
import path from 'node:path';

describe('ControlCockpit inspection entry', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../components/ControlCockpit.tsx'),
    'utf8',
  );

  it('opens and dispatches through Mission Manager without a Bridge pre-start command', () => {
    expect(source).toContain('dispatchMission(transport');
    expect(source).toContain('if (missionsOpen && missionConnected) refreshRoutes()');
    expect(source).not.toContain('/rosdeck/');
    expect(source).not.toContain('commandInspectionRuntime');
  });

  it('derives the active patrol presentation from MissionStatus only', () => {
    expect(source).toContain('ACTIVE_MISSION_STATES.includes(missionState)');
    expect(source).toContain('active={missionActive}');
    expect(source).not.toContain('mission_active');
  });
});
