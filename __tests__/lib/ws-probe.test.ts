import { probeWebSocket } from '../../lib/ws-probe';

describe('probeWebSocket', () => {
  it('rejects a malformed host before invoking the native WebSocket', async () => {
    const WebSocketMock = jest.fn();
    global.WebSocket = WebSocketMock as any;

    await expect(probeWebSocket('192.168.1.50:', 8765)).resolves.toBe(false);
    expect(WebSocketMock).not.toHaveBeenCalled();
  });

  it('requires the server to select an offered subprotocol', async () => {
    const socket: any = {
      protocol: '',
      close: jest.fn(),
      onopen: null,
      onerror: null,
      onclose: null,
    };
    global.WebSocket = jest.fn(() => socket) as any;

    const probing = probeWebSocket('192.168.1.50', 8765, {
      protocols: ['foxglove.sdk.v1'],
    });
    socket.onopen?.({});
    await expect(probing).resolves.toBe(false);
  });

  it('accepts a selected legacy Foxglove subprotocol', async () => {
    const socket: any = {
      protocol: 'foxglove.websocket.v1',
      close: jest.fn(),
      onopen: null,
      onerror: null,
      onclose: null,
    };
    const WebSocketMock = jest.fn(() => socket);
    global.WebSocket = WebSocketMock as any;

    const probing = probeWebSocket('robot.example', 443, {
      protocols: ['foxglove.sdk.v1', 'foxglove.websocket.v1'],
      scheme: 'wss',
      path: '/foxglove?token=abc',
    });
    socket.onopen?.({});

    await expect(probing).resolves.toBe(true);
    expect(WebSocketMock).toHaveBeenCalledWith(
      'wss://robot.example:443/foxglove?token=abc',
      ['foxglove.sdk.v1', 'foxglove.websocket.v1'],
    );
  });
});
