import { FoxgloveTransport } from '../../lib/foxglove-transport';

describe('FoxgloveTransport connection', () => {
  let socket: any;
  let WebSocketMock: jest.Mock;

  beforeEach(() => {
    socket = {
      binaryType: 'blob',
      protocol: 'foxglove.sdk.v1',
      close: jest.fn(),
      send: jest.fn(),
      onopen: null,
      onerror: null,
      onclose: null,
      onmessage: null,
    };
    WebSocketMock = jest.fn(() => socket);
    global.WebSocket = WebSocketMock as any;
  });

  it('advertises both the SDK and legacy Foxglove subprotocols', async () => {
    const transport = new FoxgloveTransport();
    const connecting = transport.connect('ws://192.168.1.50:8765');

    expect(WebSocketMock).toHaveBeenCalledWith(
      'ws://192.168.1.50:8765',
      ['foxglove.sdk.v1', 'foxglove.websocket.v1'],
    );
    socket.onopen?.({});
    await expect(connecting).resolves.toBeUndefined();
    expect(transport.getStatus()).toBe('connected');
  });

  it('canonicalizes a bare host before invoking the native WebSocket', async () => {
    const transport = new FoxgloveTransport();
    const connecting = transport.connect(' 192.168.1.50 ');

    expect(WebSocketMock).toHaveBeenCalledWith(
      'ws://192.168.1.50:8765',
      ['foxglove.sdk.v1', 'foxglove.websocket.v1'],
    );
    socket.onopen?.({});
    await expect(connecting).resolves.toBeUndefined();
  });

  it('rejects an unfinished URL before invoking the native WebSocket', async () => {
    const transport = new FoxgloveTransport();
    await expect(transport.connect('ws://192.168.1.50:')).rejects.toThrow('Invalid WebSocket URL');
    expect(WebSocketMock).not.toHaveBeenCalled();
  });

  it('rejects a server which does not negotiate a Foxglove subprotocol', async () => {
    socket.protocol = '';
    const transport = new FoxgloveTransport();
    const connecting = transport.connect('ws://192.168.1.50:8765');
    socket.onopen?.({});

    await expect(connecting).rejects.toThrow('Foxglove subprotocol negotiation failed');
    expect(socket.close).toHaveBeenCalled();
  });

  it('stays disconnected when cancelled before the socket opens', async () => {
    const transport = new FoxgloveTransport();
    const connecting = transport.connect('192.168.1.50');

    transport.disconnect();

    await expect(connecting).rejects.toThrow('Connection cancelled');
    socket.onopen?.({});
    socket.onclose?.({ code: 1000, reason: '' });
    expect(socket.close).toHaveBeenCalledTimes(2);
    expect(transport.getStatus()).toBe('disconnected');
  });

  it('preserves an explicit secure reverse-proxy endpoint', async () => {
    const transport = new FoxgloveTransport();
    const connecting = transport.connect('wss://robot.example/foxglove');

    expect(WebSocketMock).toHaveBeenCalledWith(
      'wss://robot.example/foxglove',
      ['foxglove.sdk.v1', 'foxglove.websocket.v1'],
    );
    socket.onopen?.({});
    await expect(connecting).resolves.toBeUndefined();
  });
});
