import { FoxgloveTransport } from '../../lib/foxglove-transport';
import { MessageReader, MessageWriter } from '@foxglove/rosmsg2-serialization';
import { parse as parseMessageDefinition } from '@foxglove/rosmsg';

const SET_RUN_MODE_REQUEST_SCHEMA = `uint8 target_state
uint8 mode
string req_id
bool pre_check
bool has_is_traction_user_param
bool is_traction_user_param`;
const SET_RUN_MODE_RESPONSE_SCHEMA = `bool success
string message
int32 error_code`;

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

  it('re-advertises a topic when its message type changes', async () => {
    const transport = new FoxgloveTransport();
    const connecting = transport.connect('ws://192.168.1.50:8765');
    socket.onopen?.({});
    await connecting;

    transport.publish('/vel_cmd', 'geometry_msgs/msg/TwistStamped', { twist: {} });
    transport.publish('/vel_cmd', 'geometry_msgs/msg/Twist', { linear: {}, angular: {} });

    const controlMessages = socket.send.mock.calls
      .map(([value]: [unknown]) => value)
      .filter((value: unknown): value is string => typeof value === 'string')
      .map((value: string) => JSON.parse(value));

    expect(controlMessages).toEqual([
      expect.objectContaining({
        op: 'advertise',
        channels: [expect.objectContaining({ topic: '/vel_cmd', schemaName: 'geometry_msgs/msg/TwistStamped' })],
      }),
      { op: 'unadvertise', channelIds: [1] },
      expect.objectContaining({
        op: 'advertise',
        channels: [expect.objectContaining({ topic: '/vel_cmd', schemaName: 'geometry_msgs/msg/Twist' })],
      }),
    ]);
  });

  it('calls an advertised ROS 2 service using CDR and decodes its CDR response', async () => {
    const transport = new FoxgloveTransport();
    const connecting = transport.connect('ws://192.168.1.50:8765');
    socket.onopen?.({});
    await connecting;
    socket.onmessage?.({ data: JSON.stringify({
      op: 'advertiseServices',
      services: [{
        id: 7,
        name: '/locomotion/set_run_mode',
        type: 'function_msgs/srv/SetRunMode',
      }],
    }) });

    const responsePromise = transport.callService(
      '/locomotion/set_run_mode',
      'function_msgs/srv/SetRunMode',
      {
        target_state: 1,
        mode: 2,
        req_id: 'rosdeck',
        pre_check: false,
        has_is_traction_user_param: false,
        is_traction_user_param: false,
      },
    );
    const request = socket.send.mock.calls.at(-1)?.[0] as Uint8Array;
    const requestView = new DataView(request.buffer, request.byteOffset, request.byteLength);
    expect(requestView.getUint8(0)).toBe(2);
    expect(requestView.getUint32(1, true)).toBe(7);
    const callId = requestView.getUint32(5, true);
    const encodingLength = requestView.getUint32(9, true);
    expect(new TextDecoder().decode(request.subarray(13, 13 + encodingLength))).toBe('cdr');
    const requestReader = new MessageReader(parseMessageDefinition(SET_RUN_MODE_REQUEST_SCHEMA, { ros2: true }));
    expect(requestReader.readMessage(request.subarray(13 + encodingLength))).toEqual({
      target_state: 1,
      mode: 2,
      req_id: 'rosdeck',
      pre_check: false,
      has_is_traction_user_param: false,
      is_traction_user_param: false,
    });

    const encoding = new TextEncoder().encode('cdr');
    const responseWriter = new MessageWriter(parseMessageDefinition(SET_RUN_MODE_RESPONSE_SCHEMA, { ros2: true }));
    const body = responseWriter.writeMessage({ success: true, message: 'ok', error_code: 0 });
    const response = new Uint8Array(13 + encoding.length + body.length);
    const responseView = new DataView(response.buffer);
    responseView.setUint8(0, 3);
    responseView.setUint32(1, 7, true);
    responseView.setUint32(5, callId, true);
    responseView.setUint32(9, encoding.length, true);
    response.set(encoding, 13);
    response.set(body, 13 + encoding.length);
    socket.onmessage?.({ data: response.buffer });

    await expect(responsePromise).resolves.toEqual({ success: true, message: 'ok', error_code: 0 });
  });

  it('rejects a failed Foxglove service call', async () => {
    const transport = new FoxgloveTransport();
    const connecting = transport.connect('ws://192.168.1.50:8765');
    socket.onopen?.({});
    await connecting;
    socket.onmessage?.({ data: JSON.stringify({
      op: 'advertiseServices',
      services: [{ id: 9, name: '/locomotion/set_run_mode', type: 'function_msgs/srv/SetRunMode' }],
    }) });
    const promise = transport.callService(
      '/locomotion/set_run_mode',
      'function_msgs/srv/SetRunMode',
      { target_state: 1, mode: 2 },
    );
    const request = socket.send.mock.calls.at(-1)?.[0] as Uint8Array;
    const callId = new DataView(request.buffer, request.byteOffset, request.byteLength).getUint32(5, true);
    socket.onmessage?.({ data: JSON.stringify({
      op: 'serviceCallFailure', serviceId: 9, callId, message: 'service unavailable',
    }) });
    await expect(promise).rejects.toThrow('service unavailable');
  });
});

describe('FoxgloveTransport gateway login', () => {
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

  it('sends the login frame as the first message when login options are given', async () => {
    const transport = new FoxgloveTransport();
    const connecting = transport.connect('wss://192.168.1.50:8765', {
      login: { user: 'alice', token: 'omni_abc' },
    });
    socket.onopen?.({});
    await expect(connecting).resolves.toBeUndefined();

    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({
      op: 'login',
      user: 'alice',
      token: 'omni_abc',
    });
  });

  it('does not send a login frame when no options are given', async () => {
    const transport = new FoxgloveTransport();
    const connecting = transport.connect('wss://192.168.1.50:8765');
    socket.onopen?.({});
    await expect(connecting).resolves.toBeUndefined();

    expect(socket.send).not.toHaveBeenCalled();
  });

  it.each([
    [1008, 'authentication failed', 'Authentication failed'],
    [4403, 'rate limited', 'Too many failed logins'],
  ])('maps close code %i (%s) to a readable terminal error', async (code, gatewayReason, expected) => {
    const transport = new FoxgloveTransport();
    const events: Array<{ status: string; error?: string }> = [];
    transport.onStatus((status, error) => events.push({ status, error }));
    const connecting = transport.connect('wss://192.168.1.50:8765', {
      login: { user: 'alice', token: 'omni_bad' },
    });
    socket.onopen?.({});
    await expect(connecting).resolves.toBeUndefined();

    socket.onclose?.({ code, reason: gatewayReason });

    expect(transport.getStatus()).toBe('error');
    expect(events.at(-1)).toEqual({
      status: 'error',
      error: expect.stringContaining(expected),
    });
  });

  it('rejects connect with a readable message when login is refused before open', async () => {
    const transport = new FoxgloveTransport();
    const connecting = transport.connect('wss://192.168.1.50:8765', {
      login: { user: 'alice', token: 'omni_bad' },
    });

    socket.onclose?.({ code: 1008, reason: 'login timeout' });

    await expect(connecting).rejects.toThrow('Authentication failed');
    expect(transport.getStatus()).toBe('error');
  });

  it('keeps reconnect semantics for non-auth close codes', async () => {
    const transport = new FoxgloveTransport();
    const connecting = transport.connect('wss://192.168.1.50:8765');
    socket.onopen?.({});
    await expect(connecting).resolves.toBeUndefined();

    socket.onclose?.({ code: 1006, reason: '' });

    expect(transport.getStatus()).toBe('disconnected');
  });
});
