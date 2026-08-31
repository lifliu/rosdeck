jest.mock('../../lib/ws-probe', () => ({
  probeWebSocket: jest.fn(),
}));

import { autoDetect, parseInput } from '../../lib/auto-detect';
import { probeWebSocket } from '../../lib/ws-probe';
import { FOXGLOVE_WEBSOCKET_PROTOCOLS } from '../../constants/defaults';
import { useRosStore } from '../../stores/useRosStore';

const mockProbe = probeWebSocket as jest.MockedFunction<typeof probeWebSocket>;

describe('autoDetect', () => {
  beforeEach(() => {
    mockProbe.mockReset();
    useRosStore.getState().reset();
  });

  it('keeps both current and legacy Foxglove subprotocols enabled', () => {
    expect(FOXGLOVE_WEBSOCKET_PROTOCOLS).toEqual([
      'foxglove.sdk.v1',
      'foxglove.websocket.v1',
    ]);
  });

  it('does not probe while the user is entering a port', async () => {
    expect(parseInput('192.168.1.50:').kind).toBe('incomplete');
    await expect(autoDetect('192.168.1.50:')).resolves.toBeNull();
    expect(mockProbe).not.toHaveBeenCalled();
  });

  it('offers both Foxglove subprotocol generations on the default port', async () => {
    mockProbe
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(autoDetect('192.168.1.50')).resolves.toEqual({
      transport: 'foxglove',
      url: 'ws://192.168.1.50:8765',
      host: '192.168.1.50',
      port: 8765,
    });
    expect(mockProbe).toHaveBeenNthCalledWith(2, '192.168.1.50', 8765, {
      protocols: ['foxglove.sdk.v1', 'foxglove.websocket.v1'],
      scheme: 'ws',
      path: '',
    });
  });

  it('detects Foxglove on a custom port and preserves wss', async () => {
    mockProbe
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(autoDetect('wss://robot.local:9876')).resolves.toEqual({
      transport: 'foxglove',
      url: 'wss://robot.local:9876',
      host: 'robot.local',
      port: 9876,
    });
    expect(mockProbe).toHaveBeenLastCalledWith('robot.local', 9876, {
      protocols: FOXGLOVE_WEBSOCKET_PROTOCOLS,
      scheme: 'wss',
      path: '',
    });
  });

  it('probes an explicit wss reverse-proxy URL on port 443 without rewriting its path', async () => {
    mockProbe
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(autoDetect('wss://robot.example/foxglove')).resolves.toEqual({
      transport: 'foxglove',
      url: 'wss://robot.example:443/foxglove',
      host: 'robot.example',
      port: 443,
    });
    expect(mockProbe).toHaveBeenLastCalledWith('robot.example', 443, {
      protocols: FOXGLOVE_WEBSOCKET_PROTOCOLS,
      scheme: 'wss',
      path: '/foxglove',
    });
  });

  it('classifies a generic-only explicit port as rosbridge', async () => {
    mockProbe
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(autoDetect('robot.local:9876')).resolves.toMatchObject({
      transport: 'rosbridge',
      url: 'ws://robot.local:9876',
    });
  });

  it('returns null when neither explicit-port handshake succeeds', async () => {
    mockProbe.mockResolvedValue(false);
    await expect(autoDetect('robot.local:9876')).resolves.toBeNull();
  });

  it('prefers positive Foxglove identification when both same-port probes open', async () => {
    mockProbe.mockResolvedValue(true);

    await expect(autoDetect('robot.local:9876')).resolves.toMatchObject({
      transport: 'foxglove',
      url: 'ws://robot.local:9876',
    });
  });
});
