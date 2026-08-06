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
  START_MAPPING_TOPIC,
} from '../../components/MappingControl';

describe('MappingControl protocol', () => {
  it('uses fixed ROS topics for mapping commands and acknowledgements', () => {
    expect(START_MAPPING_TOPIC).toBe('/rosdeck/start_3d_mapping');
    expect(MAPPING_STATUS_TOPIC).toBe('/rosdeck/3d_mapping_status');
  });

  it('extracts String messages and rejects malformed status payloads', () => {
    expect(extractMappingStatus({ data: 'started:123' })).toBe('started:123');
    expect(extractMappingStatus({ data: 123 })).toBe('');
    expect(extractMappingStatus(null)).toBe('');
  });
});
