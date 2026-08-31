// __tests__/lib/rosbridge-transport.test.ts

const mockRos = {
  on: jest.fn(),
  close: jest.fn(),
  getTopics: jest.fn(),
};
const mockRosConstructor = jest.fn(() => mockRos);

jest.mock('roslib', () => {
  return {
    __esModule: true,
    default: { Ros: mockRosConstructor, Topic: jest.fn(), Message: jest.fn() },
  };
});

import { RosbridgeTransport } from '../../lib/rosbridge-transport';

describe('RosbridgeTransport', () => {
  let transport: RosbridgeTransport;

  beforeEach(() => {
    jest.clearAllMocks();
    transport = new RosbridgeTransport();
    mockRos.on.mockImplementation((event: string, callback: () => void) => {
      if (event === 'connection') callback();
    });
  });

  it('starts disconnected', () => {
    expect(transport.getStatus()).toBe('disconnected');
  });

  it('disconnect is safe when not connected', () => {
    expect(() => transport.disconnect()).not.toThrow();
  });

  it('rejects an unfinished URL before invoking roslib', async () => {
    await expect(transport.connect('ws://192.168.1.50:')).rejects.toThrow('Invalid WebSocket URL');
    expect(mockRosConstructor).not.toHaveBeenCalled();
  });

  it('canonicalizes a bare host before invoking roslib', async () => {
    await expect(transport.connect(' 192.168.1.50 ')).resolves.toBeUndefined();
    expect(mockRosConstructor).toHaveBeenCalledWith({
      url: 'ws://192.168.1.50:9090',
    });
  });
});
