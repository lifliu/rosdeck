import { parse as parseMessageDefinition } from '@foxglove/rosmsg';
import { MessageReader, MessageWriter } from '@foxglove/rosmsg2-serialization';
import {
  MAP_CATALOG_SERVICE,
  MAP_CATALOG_SERVICE_TYPE,
  formatMapSize,
  isCompleteMapIdentity,
  listMaps,
} from '../../lib/maps';
import { getLocalServiceSchema } from '../../lib/ros-service-schemas';
import type { Transport } from '../../lib/transport';

function makeTransport(response: Record<string, unknown>): Transport {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
    subscribe: jest.fn().mockReturnValue({ unsubscribe: jest.fn() }),
    publish: jest.fn(),
    callService: jest.fn().mockResolvedValue(response),
    getTopics: jest.fn().mockResolvedValue([]),
    onStatus: jest.fn().mockReturnValue(jest.fn()),
    getStatus: jest.fn().mockReturnValue('connected'),
  };
}

const checksumA = 'a'.repeat(64);
const checksumB = 'b'.repeat(64);

describe('map catalog API', () => {
  it('calls only the public Mission service and preserves each exact identity row', async () => {
    const transport = makeTransport({
      map_ids: ['factory-a', 'matrix_sim'],
      map_versions: new Uint32Array([3, 7]),
      map_checksums: [checksumA, checksumB],
      created_at: ['2026-09-06T03:04:05+00:00', '2026-09-05T12:00:00Z'],
      size_bytes: new BigUint64Array([1_048_576n, 2_500n]),
    });

    await expect(listMaps(transport)).resolves.toEqual([
      {
        mapId: 'factory-a',
        mapVersion: 3,
        mapChecksum: checksumA,
        createdAt: '2026-09-06T03:04:05+00:00',
        sizeBytes: 1_048_576n,
      },
      {
        mapId: 'matrix_sim',
        mapVersion: 7,
        mapChecksum: checksumB,
        createdAt: '2026-09-05T12:00:00Z',
        sizeBytes: 2_500n,
      },
    ]);
    expect(transport.callService).toHaveBeenCalledWith(
      MAP_CATALOG_SERVICE,
      MAP_CATALOG_SERVICE_TYPE,
      {},
    );
    expect(MAP_CATALOG_SERVICE).toBe('/omni/maps/list');
    expect(MAP_CATALOG_SERVICE).not.toContain('/omni/slam/');
  });

  it('supports a bridge that exposes uint64 as decimal strings', async () => {
    const transport = makeTransport({
      mapIds: ['map-1'],
      mapVersions: [1],
      mapChecksums: [checksumA],
      createdAt: ['2026-09-06T03:04:05.123Z'],
      sizeBytes: ['18446744073709551615'],
    });
    const entries = await listMaps(transport);
    expect(entries[0].sizeBytes).toBe(0xffff_ffff_ffff_ffffn);
  });

  it('rejects misaligned arrays instead of producing cross-row identities', async () => {
    const transport = makeTransport({
      map_ids: ['a', 'b'],
      map_versions: [1],
      map_checksums: [checksumA, checksumB],
      created_at: ['2026-09-06T03:04:05Z', '2026-09-06T03:04:06Z'],
      size_bytes: [1, 2],
    });
    await expect(listMaps(transport)).rejects.toThrow('字段长度不一致');
  });

  it('rejects duplicate current rows for one map id', async () => {
    const transport = makeTransport({
      map_ids: ['map-a', 'map-a'],
      map_versions: [1, 2],
      map_checksums: [checksumA, checksumB],
      created_at: ['2026-09-06T03:04:05Z', '2026-09-06T03:04:06Z'],
      size_bytes: [1, 2],
    });
    await expect(listMaps(transport)).rejects.toThrow('重复的 current 地图');
  });

  it.each([
    ['unsafe map id', { map_ids: ['../escape'] }],
    ['zero version', { map_versions: [0] }],
    ['non-SHA checksum', { map_checksums: ['map-sha'] }],
    ['local timestamp', { created_at: ['2026-09-06T03:04:05'] }],
    ['empty asset', { size_bytes: [0] }],
  ])('fails closed on %s', async (_name, override) => {
    const transport = makeTransport({
      map_ids: ['map-a'],
      map_versions: [1],
      map_checksums: [checksumA],
      created_at: ['2026-09-06T03:04:05Z'],
      size_bytes: [1],
      ...override,
    });
    await expect(listMaps(transport)).rejects.toThrow('身份或元数据无效');
  });

  it('validates a mode-request identity as one complete triple', () => {
    expect(isCompleteMapIdentity({
      mapId: 'map-a',
      mapVersion: 1,
      mapChecksum: checksumA,
    })).toBe(true);
    expect(isCompleteMapIdentity({
      mapId: 'map-a',
      mapVersion: 1,
      mapChecksum: '',
    })).toBe(false);
    expect(formatMapSize(1_048_576n)).toBe('1.0 MB');
  });

  it('pins a CDR-compatible ListMaps fallback schema', () => {
    const requestSchema = getLocalServiceSchema(MAP_CATALOG_SERVICE_TYPE, 'request');
    const responseSchema = getLocalServiceSchema(MAP_CATALOG_SERVICE_TYPE, 'response');
    expect(requestSchema).toBe('# Empty request.');
    expect(responseSchema).toContain('uint64[] size_bytes');

    const writer = new MessageWriter(parseMessageDefinition(responseSchema!, { ros2: true }));
    const body = writer.writeMessage({
      map_ids: ['map-a'],
      map_versions: new Uint32Array([2]),
      map_checksums: [checksumA],
      created_at: ['2026-09-06T03:04:05Z'],
      size_bytes: new BigUint64Array([4096n]),
    });
    const decoded = new MessageReader(
      parseMessageDefinition(responseSchema!, { ros2: true }),
    ).readMessage(body) as any;
    expect(decoded.map_ids).toEqual(['map-a']);
    expect(decoded.map_versions).toEqual(new Uint32Array([2]));
    expect(decoded.size_bytes).toEqual(new BigUint64Array([4096n]));
  });
});
