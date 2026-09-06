import fs from 'node:fs';
import path from 'node:path';

describe('MapWidget goal selection boundary', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../../widgets/map/MapWidget.tsx'),
    'utf8',
  );

  it('reports world coordinates but never publishes a navigation topic', () => {
    expect(source).toContain('props.onGoalSelected');
    expect(source).toContain('goalSelectionEnabled');
    expect(source).not.toContain('nav2GoalTopic');
    expect(source).not.toContain("'/goal_pose'");
    expect(source).not.toContain('transport.publish');
    expect(source).toContain('props.goalMarker === undefined');
    expect(source).toContain('handleRobotCentricLongPress');
    expect(source).toContain('robotCentricCanvasToWorld');
    expect(source).toContain('frameId: OMNI_MAP_FRAME');
    expect(source).toContain('modeBCanonicalTfReady');
    expect(source).toContain('scanFrameTransform !== null');
    expect(source).toContain('robotInMap !== null');
    expect(source).toContain('props.assetIdentityKey');
    expect(source).toContain('String(latest.header?.frame_id || "")');
    expect(source).toContain('String(mapData.info.frameId || "")');
  });
});
