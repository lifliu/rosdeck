jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  StyleSheet: { create: (value: unknown) => value },
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

import {
  parsePostureStatus,
  POSTURE_COMMANDS,
  POSTURE_COMMAND_TOPIC,
  POSTURE_MESSAGE_TYPE,
  POSTURE_STATUS_TOPIC,
} from '../../components/PostureControl';

describe('PostureControl protocol', () => {
  it('uses fixed standard-message topics and allowlisted commands', () => {
    expect(POSTURE_COMMAND_TOPIC).toBe('/rosdeck/posture_command');
    expect(POSTURE_STATUS_TOPIC).toBe('/rosdeck/posture_status');
    expect(POSTURE_MESSAGE_TYPE).toBe('std_msgs/msg/String');
    expect(POSTURE_COMMANDS).toEqual({
      stand: { data: 'stand' },
      lieDown: { data: 'lie_down' },
    });
  });

  it('parses success and error acknowledgements', () => {
    expect(parsePostureStatus({ data: 'success:stand' })).toEqual({
      result: 'success', command: 'stand', details: '',
    });
    expect(parsePostureStatus({ data: 'error:lie_down:service_not_ready' })).toEqual({
      result: 'error', command: 'lie_down', details: 'service_not_ready',
    });
    expect(parsePostureStatus({ data: 'started:stand' })).toBeNull();
    expect(parsePostureStatus({ data: 3 })).toBeNull();
  });
});
