export interface PointCloudPoint {
  x: number;
  y: number;
  z: number;
  intensity: number;
}

export interface Point3D {
  x: number;
  y: number;
  z: number;
}

export interface ProjectionCamera {
  yaw: number;
  pitch: number;
  zoom: number;
  target: Point3D;
  /** Width/height of the shorter viewport edge at zoom=1, in metres. */
  viewMeters: number;
}

export interface ProjectedPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * 将正交点云视图上的触点反投影到给定高度的水平面。
 *
 * PointCloud3D 使用固定米制正交投影，因此无需猜测点云包围盒；只要视角
 * 未与地面平行，屏幕点与 `z=groundZ` 平面就有唯一交点。返回坐标与
 * `camera.target` 同属一个地图坐标系。
 */
export function unprojectPointCloudGround(
  canvasX: number,
  canvasY: number,
  width: number,
  height: number,
  camera: ProjectionCamera,
  groundZ = 0,
): Point3D | null {
  if (![canvasX, canvasY, width, height, camera.yaw, camera.pitch,
    camera.zoom, camera.target.x, camera.target.y, camera.target.z,
    camera.viewMeters, groundZ].every(Number.isFinite) ||
      width <= 0 || height <= 0 || camera.zoom <= 0 || camera.viewMeters <= 0) {
    return null;
  }

  const cosPitch = Math.cos(camera.pitch);
  if (Math.abs(cosPitch) < 1e-6) return null;
  const pixelsPerMeter =
    (Math.min(width, height) / Math.max(1, camera.viewMeters)) * camera.zoom;
  const rotatedX = (canvasX - width / 2) / pixelsPerMeter;
  const projectedY = -(canvasY - height / 2) / pixelsPerMeter;
  const dz = groundZ - camera.target.z;
  const rotatedY = (projectedY + Math.sin(camera.pitch) * dz) / cosPitch;
  const cosYaw = Math.cos(camera.yaw);
  const sinYaw = Math.sin(camera.yaw);

  return {
    x: camera.target.x + cosYaw * rotatedX + sinYaw * rotatedY,
    y: camera.target.y - sinYaw * rotatedX + cosYaw * rotatedY,
    z: groundZ,
  };
}

/**
 * Orthographic world-metre projection around a fixed target. The scale never
 * depends on point-cloud bounds, so receiving a larger scan cannot zoom the
 * viewport in or out.
 */
export function projectPointCloud(
  points: PointCloudPoint[],
  width: number,
  height: number,
  camera: ProjectionCamera,
): ProjectedPoint[] {
  if (width <= 0 || height <= 0) return [];
  const pixelsPerMeter = (Math.min(width, height) / Math.max(1, camera.viewMeters)) * camera.zoom;
  const cosYaw = Math.cos(camera.yaw);
  const sinYaw = Math.sin(camera.yaw);
  const cosPitch = Math.cos(camera.pitch);
  const sinPitch = Math.sin(camera.pitch);

  return points.map((point) => {
    const dx = point.x - camera.target.x;
    const dy = point.y - camera.target.y;
    const dz = point.z - camera.target.z;
    const rotatedX = cosYaw * dx - sinYaw * dy;
    const rotatedY = sinYaw * dx + cosYaw * dy;
    const screenY = -(cosPitch * rotatedY - sinPitch * dz);
    return {
      x: width / 2 + rotatedX * pixelsPerMeter,
      y: height / 2 + screenY * pixelsPerMeter,
      z: point.z,
    };
  });
}

interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

interface RigidTransform {
  translation: Point3D;
  rotation: Quaternion;
}

function multiplyQuaternion(a: Quaternion, b: Quaternion): Quaternion {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

function conjugate(q: Quaternion): Quaternion {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

function rotate(point: Point3D, q: Quaternion): Point3D {
  const value = multiplyQuaternion(
    multiplyQuaternion(q, { ...point, w: 0 }),
    conjugate(q),
  );
  return { x: value.x, y: value.y, z: value.z };
}

function compose(first: RigidTransform, second: RigidTransform): RigidTransform {
  const translated = rotate(second.translation, first.rotation);
  return {
    translation: {
      x: first.translation.x + translated.x,
      y: first.translation.y + translated.y,
      z: first.translation.z + translated.z,
    },
    rotation: multiplyQuaternion(first.rotation, second.rotation),
  };
}

function inverse(transform: RigidTransform): RigidTransform {
  const rotation = conjugate(transform.rotation);
  const translation = rotate({
    x: -transform.translation.x,
    y: -transform.translation.y,
    z: -transform.translation.z,
  }, rotation);
  return { translation, rotation };
}

const IDENTITY_TRANSFORM: RigidTransform = {
  translation: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
};

/** Maintains a bidirectional 3D TF graph and resolves a frame position. */
export class TfPositionTracker {
  private edges = new Map<string, Map<string, RigidTransform>>();

  clear(): void {
    this.edges.clear();
  }

  update(message: any): void {
    for (const item of message?.transforms ?? []) {
      const parent = String(item?.header?.frame_id ?? '').replace(/^\//, '');
      const child = String(item?.child_frame_id ?? '').replace(/^\//, '');
      if (!parent || !child) continue;
      const value: RigidTransform = {
        translation: {
          x: Number(item?.transform?.translation?.x ?? 0),
          y: Number(item?.transform?.translation?.y ?? 0),
          z: Number(item?.transform?.translation?.z ?? 0),
        },
        rotation: {
          x: Number(item?.transform?.rotation?.x ?? 0),
          y: Number(item?.transform?.rotation?.y ?? 0),
          z: Number(item?.transform?.rotation?.z ?? 0),
          w: Number(item?.transform?.rotation?.w ?? 1),
        },
      };
      this.setEdge(parent, child, value);
      this.setEdge(child, parent, inverse(value));
    }
  }

  /**
   * 查询 `fromFrame_T_toFrame`，即把 toFrame 原点/坐标表达在 fromFrame 中。
   * 该方向与 ROS TF 的 target/source 查询语义保持一致。
   */
  private lookupTransform(fromFrame: string, toFrame: string): RigidTransform | null {
    const from = fromFrame.replace(/^\//, '');
    const to = toFrame.replace(/^\//, '');
    if (!from || !to) return null;
    const queue: Array<{ frame: string; transform: RigidTransform }> = [
      { frame: from, transform: IDENTITY_TRANSFORM },
    ];
    const visited = new Set([from]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.frame === to) return current.transform;
      for (const [next, edge] of this.edges.get(current.frame) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push({ frame: next, transform: compose(current.transform, edge) });
      }
    }
    return null;
  }

  lookupPosition(fromFrame: string, toFrame: string): Point3D | null {
    return this.lookupTransform(fromFrame, toFrame)?.translation ?? null;
  }

  /**
   * 把一帧点云从 sourceFrame 转换到 targetFrame。
   *
   * FAST-LIO 建图输出的 `/cloud_registered_global` 使用 `omni_odom`，而
   * APP 的规范显示坐标系是 `omni_map`。不能仅凭话题名改写 frame_id；必须
   * 使用 omni_tf_manager 发布的真实 TF。TF 尚未就绪时返回 null，调用方
   * 保留已有预览并等待下一帧，避免混入不同坐标系的数据。
   */
  transformPointCloud(
    points: PointCloudPoint[],
    sourceFrame: string,
    targetFrame: string,
  ): PointCloudPoint[] | null {
    const source = sourceFrame.replace(/^\//, '');
    const target = targetFrame.replace(/^\//, '');
    if (!source || !target) return null;
    if (source === target) return points;

    // lookupTransform(target, source) 返回 target_T_source。
    const transform = this.lookupTransform(target, source);
    if (!transform) return null;
    return points.map((point) => {
      const rotated = rotate(point, transform.rotation);
      return {
        x: rotated.x + transform.translation.x,
        y: rotated.y + transform.translation.y,
        z: rotated.z + transform.translation.z,
        intensity: point.intensity,
      };
    });
  }

  private setEdge(from: string, to: string, transform: RigidTransform): void {
    if (!this.edges.has(from)) this.edges.set(from, new Map());
    this.edges.get(from)!.set(to, transform);
  }
}

interface PointFieldLike {
  name: string;
  offset: number;
  datatype: number;
}

function asBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (Array.isArray(data)) return Uint8Array.from(data);
  if (typeof data === 'string') {
    try {
      // rosbridge 按 JSON 协议把 uint8[] 编码为 base64；Foxglove/CDR 则
      // 直接给 Uint8Array。两条产品连接链路必须得到完全相同的解析结果。
      return Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
    } catch {
      return null;
    }
  }
  return null;
}

/** 解析 FAST-LIO PointCloud2 中的 FLOAT32 x/y/z/intensity 字段。 */
export function parsePointCloud2(message: any): PointCloudPoint[] {
  const bytes = asBytes(message?.data);
  const pointStep = Number(message?.point_step ?? 0);
  const fields = Array.isArray(message?.fields) ? message.fields as PointFieldLike[] : [];
  if (!bytes || pointStep <= 0 || fields.length === 0) return [];

  const byName = new Map(fields.map((field) => [field.name, field]));
  const xField = byName.get('x');
  const yField = byName.get('y');
  const zField = byName.get('z');
  const intensityField = byName.get('intensity');
  // sensor_msgs/PointField.FLOAT32 = 7
  if (!xField || !yField || !zField || [xField, yField, zField].some((f) => f.datatype !== 7)) {
    return [];
  }

  const declaredPoints = Number(message?.width ?? 0) * Math.max(1, Number(message?.height ?? 1));
  const pointCount = Math.min(declaredPoints || Math.floor(bytes.byteLength / pointStep), Math.floor(bytes.byteLength / pointStep));
  const littleEndian = !message?.is_bigendian;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const points: PointCloudPoint[] = [];

  for (let index = 0; index < pointCount; index += 1) {
    const base = index * pointStep;
    const x = view.getFloat32(base + Number(xField.offset), littleEndian);
    const y = view.getFloat32(base + Number(yField.offset), littleEndian);
    const z = view.getFloat32(base + Number(zField.offset), littleEndian);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const intensity = intensityField?.datatype === 7
      ? view.getFloat32(base + Number(intensityField.offset), littleEndian)
      : 0;
    points.push({ x, y, z, intensity: Number.isFinite(intensity) ? intensity : 0 });
  }
  return points;
}

function voxelKey(point: PointCloudPoint, size: number): string {
  return `${Math.floor(point.x / size)},${Math.floor(point.y / size)},${Math.floor(point.z / size)}`;
}

/** Keeps a bounded, global preview by increasing voxel size as the map grows. */
export class AdaptiveVoxelAccumulator {
  private voxels = new Map<string, PointCloudPoint>();
  private size: number;

  constructor(
    private readonly initialVoxelSize = 0.12,
    private readonly maxPoints = 60000,
  ) {
    this.size = initialVoxelSize;
  }

  clear(): void {
    this.voxels.clear();
    this.size = this.initialVoxelSize;
  }

  add(points: PointCloudPoint[]): void {
    for (const point of points) this.voxels.set(voxelKey(point, this.size), point);
    while (this.voxels.size > this.maxPoints) {
      this.size *= 1.25;
      const rebuilt = new Map<string, PointCloudPoint>();
      for (const point of this.voxels.values()) rebuilt.set(voxelKey(point, this.size), point);
      this.voxels = rebuilt;
    }
  }

  get voxelSize(): number {
    return this.size;
  }

  get pointCount(): number {
    return this.voxels.size;
  }

  snapshot(maxPoints = 18000): PointCloudPoint[] {
    const values = [...this.voxels.values()];
    if (values.length <= maxPoints) return values;
    const stride = values.length / maxPoints;
    return Array.from({ length: maxPoints }, (_, index) => values[Math.floor(index * stride)]);
  }
}
