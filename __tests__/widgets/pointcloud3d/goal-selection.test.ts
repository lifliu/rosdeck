import fs from 'node:fs';
import path from 'node:path';

describe('PointCloud3DWidget navigation boundary', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../../widgets/pointcloud3d/PointCloud3DWidget.tsx'),
    'utf8',
  );

  it('selects only verified omni_map ground points and reports them upward', () => {
    expect(source).toContain('unprojectPointCloudGround');
    expect(source).toContain('selectionFrameReady');
    expect(source).toContain('mapFrame === OMNI_MAP_FRAME');
    expect(source).toContain('props.onGoalSelected');
    expect(source).toContain('frameId: OMNI_MAP_FRAME');
  });

  it('never bypasses the typed Mission navigation facade', () => {
    expect(source).not.toContain('/goal_pose');
    expect(source).not.toContain('/omni/planner');
    expect(source).not.toContain('transport.publish');
    expect(source).not.toContain('callService');
  });

  it('clears and rejects geometry across identity and frame boundaries', () => {
    expect(source).toContain('props.assetIdentityKey');
    expect(source).toContain('transformPointCloud(decoded, frameId, mapFrame)');
    expect(source).toContain('accumulatorRef.current.clear()');
    expect(source).toContain('tfTrackerRef.current.clear()');
  });
});
