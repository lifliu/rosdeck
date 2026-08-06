jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  StyleSheet: { create: (value: unknown) => value },
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

import {
  extractMappingStatus,
  MAPPING_STATUS_TOPIC,
  START_MAPPING_MESSAGE,
  START_MAPPING_MESSAGE_TYPE,
  START_MAPPING_TOPIC,
  STOP_MAPPING_MESSAGE,
} from '../../components/MappingControl';

describe('MappingControl protocol', () => {
  it('uses fixed ROS topics for mapping commands and acknowledgements', () => {
    expect(START_MAPPING_TOPIC).toBe('/rosdeck/start_3d_mapping');
    expect(MAPPING_STATUS_TOPIC).toBe('/rosdeck/mapping_status');
    expect(START_MAPPING_MESSAGE_TYPE).toBe('std_msgs/msg/Bool');
    expect(START_MAPPING_MESSAGE).toEqual({ data: true });
    expect(STOP_MAPPING_MESSAGE).toEqual({ data: false });
  });

  it('extracts String messages and rejects malformed status payloads', () => {
    expect(extractMappingStatus({ data: 'started:123' })).toBe('started:123');
    expect(extractMappingStatus({ data: 123 })).toBe('');
    expect(extractMappingStatus(null)).toBe('');
  });
});
