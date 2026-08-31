import {
  CONTROL_COMMAND_TOPIC,
  CONTROL_MESSAGE_TYPE,
  CONTROL_STATUS_TOPIC,
  parseControlStatus,
} from '../../lib/control-authority';

describe('mobile control authority protocol', () => {
  it('uses stable ROS 2 standard-message topics', () => {
    expect(CONTROL_COMMAND_TOPIC).toBe('/rosdeck/control_command');
    expect(CONTROL_STATUS_TOPIC).toBe('/rosdeck/control_status');
    expect(CONTROL_MESSAGE_TYPE).toBe('std_msgs/msg/String');
  });

  it('parses ownership states', () => {
    expect(parseControlStatus({ data: 'available' })).toEqual({ state: 'available' });
    expect(parseControlStatus({ data: 'acquiring:app-123' })).toEqual({
      state: 'acquiring', ownerId: 'app-123',
    });
    expect(parseControlStatus({ data: 'acquired:app-123' })).toEqual({
      state: 'acquired', ownerId: 'app-123',
    });
    expect(parseControlStatus({ data: 'releasing:app-123' })).toEqual({
      state: 'releasing', ownerId: 'app-123',
    });
    expect(parseControlStatus({ data: 'cooldown:3' })).toEqual({
      state: 'cooldown', remainingSeconds: 3,
    });
  });

  it('parses errors and rejects malformed states', () => {
    expect(parseControlStatus({ data: 'error:acquire:app-123:sdk_connect_timeout' })).toEqual({
      state: 'error', action: 'acquire', clientId: 'app-123', reason: 'sdk_connect_timeout',
    });
    expect(parseControlStatus({ data: 'acquired' })).toBeNull();
    expect(parseControlStatus({ data: 'cooldown:nope' })).toBeNull();
    expect(parseControlStatus({ data: 3 })).toBeNull();
  });
});
