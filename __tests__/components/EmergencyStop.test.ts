jest.mock('react-native', () => ({
  StyleSheet: { create: (value: unknown) => value },
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

import {
  emergencyStopIsEnabled,
  EMERGENCY_STOP_REQUEST_MESSAGE,
  EMERGENCY_STOP_REQUEST_MESSAGE_TYPE,
  EMERGENCY_STOP_REQUEST_TOPIC,
  publishEmergencyStop,
  VBOT_EMERGENCY_STOP_MESSAGE,
  VBOT_EMERGENCY_STOP_MESSAGE_TYPE,
  VBOT_EMERGENCY_STOP_TOPIC,
} from '../../components/EmergencyStop';

describe('EmergencyStop protocol', () => {
  it('publishes only the canonical safety request and VBot compatibility command', () => {
    const publish = jest.fn();

    publishEmergencyStop({ publish });

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenNthCalledWith(
      1,
      EMERGENCY_STOP_REQUEST_TOPIC,
      EMERGENCY_STOP_REQUEST_MESSAGE_TYPE,
      EMERGENCY_STOP_REQUEST_MESSAGE,
    );
    expect(publish).toHaveBeenNthCalledWith(
      2,
      VBOT_EMERGENCY_STOP_TOPIC,
      VBOT_EMERGENCY_STOP_MESSAGE_TYPE,
      VBOT_EMERGENCY_STOP_MESSAGE,
    );
    expect(publish.mock.calls.map(([topic]) => topic)).toEqual([
      '/omni/safety/estop_request',
      '/rosdeck/posture_command',
    ]);
    expect(publish.mock.calls.some(([topic]) => String(topic).includes('cmd_vel'))).toBe(false);
  });

  it('does not require authority but remains disabled for Demo or disconnected sessions', () => {
    const transport = { publish: jest.fn() };

    expect(emergencyStopIsEnabled('connected', transport, 'ws://robot.local:8765')).toBe(true);
    expect(emergencyStopIsEnabled('connected', transport, 'demo://default')).toBe(false);
    expect(emergencyStopIsEnabled('disconnected', transport, 'ws://robot.local:8765')).toBe(false);
    expect(emergencyStopIsEnabled('connected', null, 'ws://robot.local:8765')).toBe(false);
  });
});
