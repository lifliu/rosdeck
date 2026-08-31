import {
  buildTwistMessage,
  buildTwistStampedMessage,
  buildWebSocketUrl,
  createRosConnection,
  parseRobotIp,
} from '../../lib/ros';

describe('buildTwistMessage', () => {
  it('creates a Twist message with given velocities', () => {
    const msg = buildTwistMessage(0.5, 0.3);
    expect(msg).toEqual({
      linear: { x: 0.5, y: 0, z: 0 },
      angular: { x: 0, y: 0, z: 0.3 },
    });
  });

  it('creates a zero Twist message', () => {
    const msg = buildTwistMessage(0, 0);
    expect(msg.linear.x).toBe(0);
    expect(msg.angular.z).toBe(0);
  });
});

describe('buildTwistStampedMessage', () => {
  it('wraps Twist in stamped header with frame_id', () => {
    const msg = buildTwistStampedMessage(buildTwistMessage(0.5, 0.3), 'base_link');
    expect(msg.header.frame_id).toBe('base_link');
    expect(msg.header.stamp.sec).toBeGreaterThan(0);
    expect(msg.twist.linear.x).toBe(0.5);
    expect(msg.twist.angular.z).toBe(0.3);
  });
});

describe('buildWebSocketUrl', () => {
  it('uses the transport-specific default port', () => {
    expect(buildWebSocketUrl('192.168.1.50', 'rosbridge')).toBe('ws://192.168.1.50:9090');
    expect(buildWebSocketUrl('192.168.1.50', 'foxglove')).toBe('ws://192.168.1.50:8765');
  });

  it('preserves an explicit valid port and wss scheme', () => {
    expect(buildWebSocketUrl('wss://robot.local:9876', 'foxglove')).toBe('wss://robot.local:9876');
  });

  it('preserves an explicit URL without a port and its reverse-proxy path', () => {
    expect(buildWebSocketUrl('wss://robot.example/foxglove', 'foxglove'))
      .toBe('wss://robot.example/foxglove');
  });

  it('canonicalizes an explicit query-only reverse-proxy URL', () => {
    expect(buildWebSocketUrl('wss://robot.example?token=abc', 'foxglove'))
      .toBe('wss://robot.example/?token=abc');
  });

  it('formats a bracketed IPv6 endpoint safely', () => {
    expect(buildWebSocketUrl('[2001:db8::1]', 'foxglove'))
      .toBe('ws://[2001:db8::1]:8765');
  });

  it('does not build a URL from an unfinished port', () => {
    expect(buildWebSocketUrl('192.168.1.50:', 'foxglove')).toBeNull();
  });

  it('normalizes whitespace before a native WebSocket sees the URL', () => {
    expect(buildWebSocketUrl('  ws://192.168.1.50:9090  ', 'rosbridge'))
      .toBe('ws://192.168.1.50:9090');
  });

  it('rejects malformed URLs at the legacy roslib entry point', () => {
    expect(() => createRosConnection('ws://192.168.1.50:'))
      .toThrow('Invalid WebSocket URL');
  });
});

describe('parseRobotIp', () => {
  it('extracts IP from ws:// URL', () => {
    expect(parseRobotIp('ws://192.168.1.50:9090')).toBe('192.168.1.50');
  });

  it('extracts IP from plain IP:port input', () => {
    expect(parseRobotIp('192.168.1.50:9090')).toBe('192.168.1.50');
  });

  it('extracts IP from plain IP without port', () => {
    expect(parseRobotIp('192.168.1.50')).toBe('192.168.1.50');
  });
});
