import {
  getRouteDispatchBlockReason,
  type RouteEntry,
} from '../../lib/mission/types';

const route = (overrides: Partial<RouteEntry> = {}): RouteEntry => ({
  routeId: 'route-a',
  mapId: 'map-a',
  frameId: 'omni_map',
  createdAt: '2026-09-07T00:00:00Z',
  mapVersion: '1',
  mapChecksum: 'a'.repeat(64),
  routeChecksum: 'route-digest',
  pointCount: 3,
  distanceM: 2.5,
  ...overrides,
});

describe('getRouteDispatchBlockReason', () => {
  it('accepts a canonical route with an exact immutable map binding', () => {
    expect(getRouteDispatchBlockReason(route())).toBeNull();
  });

  it.each([
    [{ mapChecksum: '' }, 'legacy_map_binding'],
    [{ mapVersion: '' }, 'legacy_map_binding'],
    [{ mapChecksum: 'not-a-sha256' }, 'legacy_map_binding'],
    [{ frameId: 'lio_map' }, 'unsupported_frame'],
    [{ routeChecksum: '' }, 'malformed_route'],
    [{ pointCount: 1 }, 'malformed_route'],
  ] as const)('blocks incomplete or legacy route %p', (overrides, reason) => {
    expect(getRouteDispatchBlockReason(route(overrides))).toBe(reason);
  });
});
