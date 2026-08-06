import {
  AdaptiveVoxelAccumulator,
  parsePointCloud2,
  projectPointCloud,
  TfPositionTracker,
  type PointCloudPoint,
} from '../../../widgets/pointcloud3d/transforms';

function makeCloud(points: Array<[number, number, number, number]>) {
  const pointStep = 48;
  const data = new Uint8Array(points.length * pointStep);
  const view = new DataView(data.buffer);
  points.forEach(([x, y, z, intensity], index) => {
    const base = index * pointStep;
    view.setFloat32(base, x, true);
    view.setFloat32(base + 4, y, true);
    view.setFloat32(base + 8, z, true);
    view.setFloat32(base + 32, intensity, true);
  });
  return {
    width: points.length,
    height: 1,
    point_step: pointStep,
    is_bigendian: false,
    fields: [
      { name: 'x', offset: 0, datatype: 7, count: 1 },
      { name: 'y', offset: 4, datatype: 7, count: 1 },
      { name: 'z', offset: 8, datatype: 7, count: 1 },
      { name: 'intensity', offset: 32, datatype: 7, count: 1 },
    ],
    data,
  };
}

describe('PointCloud2 transforms', () => {
  it('parses the VBot FAST-LIO FLOAT32 field layout', () => {
    expect(parsePointCloud2(makeCloud([[1.25, -2.5, 0.75, 42]]))).toEqual([
      { x: 1.25, y: -2.5, z: 0.75, intensity: 42 },
    ]);
  });

  it('rejects point clouds without FLOAT32 xyz fields', () => {
    const cloud = makeCloud([[1, 2, 3, 4]]);
    cloud.fields[0].datatype = 2;
    expect(parsePointCloud2(cloud)).toEqual([]);
  });

  it('deduplicates nearby points and remains bounded', () => {
    const accumulator = new AdaptiveVoxelAccumulator(0.1, 10);
    accumulator.add([
      { x: 0.01, y: 0.01, z: 0.01, intensity: 1 },
      { x: 0.02, y: 0.02, z: 0.02, intensity: 2 },
    ]);
    expect(accumulator.pointCount).toBe(1);

    const many: PointCloudPoint[] = Array.from({ length: 100 }, (_, index) => ({
      x: index,
      y: index % 3,
      z: 0,
      intensity: index,
    }));
    accumulator.add(many);
    expect(accumulator.pointCount).toBeLessThanOrEqual(10);
    expect(accumulator.voxelSize).toBeGreaterThan(0.1);
  });

  it('uses a fixed world scale and robot-centred target', () => {
    const camera = {
      yaw: 0,
      pitch: 0,
      zoom: 1,
      target: { x: 10, y: 20, z: 0 },
      viewMeters: 20,
    };
    const first = projectPointCloud([
      { x: 11, y: 20, z: 0, intensity: 0 },
    ], 200, 100, camera);
    const withFarPoint = projectPointCloud([
      { x: 11, y: 20, z: 0, intensity: 0 },
      { x: 1000, y: 1000, z: 0, intensity: 0 },
    ], 200, 100, camera);
    expect(first[0]).toEqual({ x: 105, y: 50, z: 0 });
    expect(withFarPoint[0]).toEqual(first[0]);
  });

  it('resolves robot position through forward and inverse TF chains', () => {
    const tracker = new TfPositionTracker();
    tracker.update({ transforms: [
      {
        header: { frame_id: 'map_frame' },
        child_frame_id: 'odom',
        transform: {
          translation: { x: 10, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        },
      },
      {
        header: { frame_id: 'odom' },
        child_frame_id: 'base_link',
        transform: {
          translation: { x: 2, y: 3, z: 1 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        },
      },
    ] });
    expect(tracker.lookupPosition('map_frame', 'base_link')).toEqual({ x: 12, y: 3, z: 1 });
    expect(tracker.lookupPosition('base_link', 'map_frame')).toEqual({ x: -12, y: -3, z: -1 });
  });

  it('restores the configured voxel size after clearing', () => {
    const accumulator = new AdaptiveVoxelAccumulator(0.25, 2);
    accumulator.add(Array.from({ length: 20 }, (_, x) => ({ x, y: 0, z: 0, intensity: 0 })));
    accumulator.clear();
    expect(accumulator.voxelSize).toBe(0.25);
  });
});
