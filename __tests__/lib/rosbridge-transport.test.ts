// __tests__/lib/rosbridge-transport.test.ts

const mockRos = {
  on: jest.fn(),
  close: jest.fn(),
  getTopics: jest.fn(),
};
const mockRosConstructor = jest.fn(() => mockRos);
const mockCallService = jest.fn();
const mockPublish = jest.fn();

jest.mock('roslib', () => {
  return {
    __esModule: true,
    // roslib 2 uses plain objects; Message/ServiceRequest are no longer exports.
    default: { Ros: mockRosConstructor,
      Topic: jest.fn(() => ({ publish: mockPublish })),
      Service: jest.fn(() => ({ callService: mockCallService })),
    },
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

  it('publishes and calls services with the installed roslib 2 object API', async () => {
    await transport.connect('192.168.1.50');
    const message={data: 0.4};
    transport.publish('/test/speed','std_msgs/msg/Float64',message);
    expect(mockPublish).toHaveBeenCalledWith(message);
    mockCallService.mockImplementation((request, success) => success({accepted:true,...request}));
    await expect(transport.callService('/test/set_speed','test/srv/Speed',
      {speed_mps:.4},{timeoutMs:1500})).resolves.toEqual({accepted:true,speed_mps:.4});
    expect(mockCallService.mock.calls[0][3]).toBe(1.5);
  });

  it('bounds a missing service response', async () => {
    jest.useFakeTimers();
    try {
      await transport.connect('192.168.1.50');
      mockCallService.mockImplementation(() => undefined);
      const response=transport.callService('/test/stalled','test/srv/Empty',{}, {timeoutMs:1500});
      const assertion=expect(response).rejects.toThrow('timed out');
      jest.advanceTimersByTime(1500);
      await assertion;
    } finally { jest.useRealTimers(); }
  });
});
