import { formatConnectionUrl, parseConnectionInput } from '../../lib/connection-url';

describe('parseConnectionInput', () => {
  it.each([
    ['192.168.1.50', '192.168.1.50', null],
    ['192.168.1.50:8765', '192.168.1.50', 8765],
    ['robot.local', 'robot.local', null],
    ['ws://robot.local:9090', 'robot.local', 9090],
    ['wss://robot.local:8765/', 'robot.local', 8765],
    ['wss://robot.example/foxglove?token=abc', 'robot.example', null],
    ['wss://robot.example?token=abc', 'robot.example', null],
    ['wss://robot.example:443?token=abc', 'robot.example', 443],
    ['[2001:db8::1]', '[2001:db8::1]', null],
    ['ws://[::1]:9090', '[::1]', 9090],
  ])('parses valid input %s', (input, host, port) => {
    const parsed = parseConnectionInput(input);
    expect(parsed.kind).toBe('valid');
    expect(parsed.host).toBe(host);
    expect(parsed.port).toBe(port);
  });

  it.each([
    '192.168.1.50:',
    'robot.local:',
    '[::1]:',
    'ws://',
  ])('treats unfinished input %s as incomplete', (input) => {
    expect(parseConnectionInput(input).kind).toBe('incomplete');
  });

  it.each([
    ':8765',
    'ws://192.168.1.50::8765',
    'robot.local:abc',
    'robot.local:8765x',
    'robot.local:-1',
    'robot.local:0',
    'robot.local:65536',
    'robot .local:8765',
    'robot@local:8765',
    'robot\\local:8765',
    'robot..local:8765',
    '2001:db8::1',
    '[not-an-ipv6]:8765',
    '[1:2:3:4:5:6:7:8:]',
    '[:1:2:3:4:5:6:7:8]',
    '999.999.999.999:8765',
    'wss://robot.example/bad path',
    'wss://robot.example/%xx',
    'http://robot.local:8765',
  ])('rejects invalid input %s', (input) => {
    expect(parseConnectionInput(input).kind).toBe('invalid');
  });

  it('formats a bare endpoint with the selected default port', () => {
    const parsed = parseConnectionInput('robot.local/');
    expect(parsed.kind).toBe('valid');
    if (parsed.kind !== 'valid') throw new Error('expected valid input');
    expect(formatConnectionUrl(parsed, 8765)).toBe('ws://robot.local:8765/');
  });

  it('preserves standard-port semantics and paths for an explicit URL', () => {
    const parsed = parseConnectionInput('wss://robot.example/foxglove?token=abc');
    expect(parsed.kind).toBe('valid');
    if (parsed.kind !== 'valid') throw new Error('expected valid input');
    expect(formatConnectionUrl(parsed, 8765)).toBe('wss://robot.example/foxglove?token=abc');
  });

  it('canonicalizes a query-only URL to an explicit root path', () => {
    const parsed = parseConnectionInput('wss://robot.example?token=abc');
    expect(parsed.kind).toBe('valid');
    if (parsed.kind !== 'valid') throw new Error('expected valid input');
    expect(formatConnectionUrl(parsed, 8765)).toBe('wss://robot.example/?token=abc');
  });
});
