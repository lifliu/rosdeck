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
    expect(source).toContain('INSPECTION_COMMAND_TTL_SEC = 30 * 60');
  });

  it('derives the active patrol presentation from MissionStatus only', () => {
    expect(source).toContain('ACTIVE_MISSION_STATES.includes(missionState)');
    expect(source).toContain('active={missionActive}');
    expect(source).not.toContain('mission_active');
  });

  it('submits and cancels map goals only through the typed Mission facade', () => {
    expect(source).toContain('submitNavigationGoal(transport');
    expect(source).toContain('cancelNavigationGoal(transport');
    expect(source).toContain('goalSelectionEnabled={mapIdentityReady');
    expect(source).toContain('navigationSnapshot.stale');
    expect(source).not.toContain('/goal_pose');
    expect(source).not.toContain('/omni/planner');
    expect(source).not.toContain('transport.publish');
  });

  it('supports Matrix point-cloud selection and editable goal confirmation', () => {
    expect(source).toContain('<PointCloud3DWidget');
    expect(source).toContain('usePointCloudScene');
    expect(source).toContain('导航目标编辑器');
    expect(source).toContain('nudgePendingGoal');
    expect(source).toMatch(/buildNavigationTargetPose\(\s*OMNI_MAP_FRAME/);
    expect(source).toContain('mapFrame: OMNI_MAP_FRAME');
    expect(source).toContain('robotFrame: OMNI_BASE_FRAME');
    expect(source).toContain('assetIdentityKey={mapAssetIdentityKey}');
  });

  it('isolates goal-editor touches from the two routed joystick pads', () => {
    expect(source).toContain('cancelActiveTouches()');
    expect(source).toMatch(/if \(!pendingMapGoal\) dispatchTouchStart/);
    expect(source).toMatch(/if \(!pendingMapGoal\) dispatchTouchMove/);
  });

  it('does not introduce a second mapping control in the landscape cockpit', () => {
    expect(source).not.toContain('MappingControl');
    expect(source).not.toContain('start_3d_mapping');
  });
});
