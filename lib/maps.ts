import type { Transport } from './transport';

/** APP 只能访问 Mission Manager 暴露的公共地图目录。 */
export const MAP_CATALOG_SERVICE = '/omni/maps/list';
export const MAP_CATALOG_SERVICE_TYPE = 'omni_robot_interfaces/srv/ListMaps';

/**
 * 一条地图资产的不可拆分身份。mapId、mapVersion、mapChecksum 必须始终来自
 * 服务端响应的同一行，禁止分别从运行时状态或手机缓存补齐。
 */
export interface MapIdentity {
  mapId: string;
  mapVersion: number;
  mapChecksum: string;
}

export interface MapCatalogEntry extends MapIdentity {
  createdAt: string;
  sizeBytes: bigint;
}

const MAP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAP_CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;

export function isCompleteMapIdentity(
  identity: MapIdentity | null | undefined,
): identity is MapIdentity {
  if (!identity) return false;
  return MAP_ID_PATTERN.test(identity.mapId) &&
    Number.isInteger(identity.mapVersion) && identity.mapVersion > 0 &&
    identity.mapVersion <= 0xffff_ffff && MAP_CHECKSUM_PATTERN.test(identity.mapChecksum);
}

function field(object: any, name: string): unknown {
  const camel = name.replace(/_([a-z])/g, (_match, character: string) =>
    character.toUpperCase());
  return object?.[name] ?? object?.[camel];
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (ArrayBuffer.isView(value)) {
    return Array.from(value as unknown as ArrayLike<unknown>);
  }
  return [];
}

function asUint64(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    try {
      const converted = BigInt(value);
      return converted <= 0xffff_ffff_ffff_ffffn ? converted : null;
    } catch {
      return null;
    }
  }
  return null;
}

function isIsoTimestamp(value: string): boolean {
  // SLAM Manager 写入带时区的 ISO-8601；这里拒绝无时区的本地时间，避免排序和
  // 展示因手机时区不同而产生歧义。
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

/**
 * 从机器人实时获取地图目录。平行数组只要有一处长度或字段不合法，就拒绝整份
 * 响应；静默错位会把一个版本的 checksum 绑定到另一张地图，风险高于空列表。
 */
export async function listMaps(transport: Transport): Promise<MapCatalogEntry[]> {
  const raw = await transport.callService(
    MAP_CATALOG_SERVICE,
    MAP_CATALOG_SERVICE_TYPE,
    {},
  );
  const mapIds = asArray(field(raw, 'map_ids'));
  const mapVersions = asArray(field(raw, 'map_versions'));
  const mapChecksums = asArray(field(raw, 'map_checksums'));
  const createdAt = asArray(field(raw, 'created_at'));
  const sizeBytes = asArray(field(raw, 'size_bytes'));
  const lengths = [
    mapIds.length,
    mapVersions.length,
    mapChecksums.length,
    createdAt.length,
    sizeBytes.length,
  ];
  if (!lengths.every((length) => length === mapIds.length)) {
    throw new Error('地图目录响应字段长度不一致');
  }

  const seenMapIds = new Set<string>();
  return mapIds.map((rawMapId, index) => {
    const mapId = typeof rawMapId === 'string' ? rawMapId : '';
    const version = mapVersions[index];
    const checksum = mapChecksums[index];
    const timestamp = createdAt[index];
    const bytes = asUint64(sizeBytes[index]);
    if (
      !MAP_ID_PATTERN.test(mapId) ||
      typeof version !== 'number' || !Number.isInteger(version) ||
      version <= 0 || version > 0xffff_ffff ||
      typeof checksum !== 'string' || !MAP_CHECKSUM_PATTERN.test(checksum) ||
      typeof timestamp !== 'string' || !isIsoTimestamp(timestamp) ||
      bytes === null || bytes <= 0n
    ) {
      throw new Error(`地图目录第 ${index + 1} 项身份或元数据无效`);
    }
    if (seenMapIds.has(mapId)) {
      throw new Error(`地图目录包含重复的 current 地图：${mapId}`);
    }
    seenMapIds.add(mapId);
    return {
      mapId,
      mapVersion: version,
      mapChecksum: checksum,
      createdAt: timestamp,
      sizeBytes: bytes,
    };
  });
}

export function mapIdentityKey(identity: MapIdentity): string {
  return `${identity.mapId}\u0000${identity.mapVersion}\u0000${identity.mapChecksum}`;
}

/** 仅用于展示；内部仍保留 uint64 bigint，绝不把格式化结果带回模式请求。 */
export function formatMapSize(sizeBytes: bigint): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
  let value = Number(sizeBytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}
