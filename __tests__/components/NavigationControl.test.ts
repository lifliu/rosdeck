jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  StyleSheet: { create: (value: unknown) => value },
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

import {
  extractNavigationStatus,
  NAVIGATION_MESSAGE_TYPE,
  NAVIGATION_STATUS_TOPIC,
  parseNavigationRuntimeState,
  START_NAVIGATION_MESSAGE,
  START_NAVIGATION_TOPIC,
  STOP_NAVIGATION_MESSAGE,
} from '../../components/NavigationControl';

describe('NavigationControl protocol', () => {
  it('uses one Bool command type and one authoritative status topic', () => {
    expect(START_NAVIGATION_TOPIC).toBe('/rosdeck/start_navigation');
    expect(NAVIGATION_STATUS_TOPIC).toBe('/rosdeck/navigation_status');
    expect(NAVIGATION_MESSAGE_TYPE).toBe('std_msgs/msg/Bool');
    expect(START_NAVIGATION_MESSAGE).toEqual({ data: true });
    expect(STOP_NAVIGATION_MESSAGE).toEqual({ data: false });
  });

  it('distinguishes Bridge-managed and externally managed runtimes', () => {
    expect(parseNavigationRuntimeState('running:managed')).toBe('running_managed');
    expect(parseNavigationRuntimeState('running:external')).toBe('running_external');
    expect(parseNavigationRuntimeState('blocked:inspection_runtime')).toBe('blocked_inspection');
    expect(parseNavigationRuntimeState('blocked:inspection_mission_active')).toBe('blocked_inspection');
    expect(parseNavigationRuntimeState('blocked:inspection_mission_unknown')).toBe('blocked_inspection_unknown');
    expect(parseNavigationRuntimeState('switchable:inspection_runtime')).toBe('switchable_inspection');
    expect(parseNavigationRuntimeState('switching:inspection_runtime')).toBe('starting');
    expect(parseNavigationRuntimeState('partial:localization')).toBe('partial');
    expect(parseNavigationRuntimeState('error:planner_publisher_conflict')).toBe('error');
  });

  it('extracts String messages and rejects malformed payloads', () => {
    expect(extractNavigationStatus({ data: 'idle' })).toBe('idle');
    expect(extractNavigationStatus({ data: 1 })).toBe('');
    expect(extractNavigationStatus(null)).toBe('');
  });
});
