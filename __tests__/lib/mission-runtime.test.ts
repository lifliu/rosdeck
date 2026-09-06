import {
  INSPECTION_RUNTIME_COMMAND_TOPIC,
  commandInspectionRuntime,
  extractInspectionRuntimeStatus,
  parseInspectionRuntimeState,
} from '../../lib/mission/runtime';

describe('inspection runtime protocol', () => {
  it('parses managed, external and switching states', () => {
    expect(parseInspectionRuntimeState('idle')).toBe('idle');
    expect(parseInspectionRuntimeState('switchable:single_point_navigation')).toBe('switchable_navigation');
    expect(parseInspectionRuntimeState('switching:single_point_navigation')).toBe('starting');
    expect(parseInspectionRuntimeState('starting:managed')).toBe('starting');
    expect(parseInspectionRuntimeState('running:managed')).toBe('running_managed');
    expect(parseInspectionRuntimeState('running:external')).toBe('running_external');
    expect(parseInspectionRuntimeState('partial:planner_not_route_mode')).toBe('partial');
    expect(parseInspectionRuntimeState('error:mission_publisher_conflict')).toBe('error');
  });

  it('extracts only valid String payloads', () => {
    expect(extractInspectionRuntimeStatus({ data: 'running:managed' })).toBe('running:managed');
    expect(extractInspectionRuntimeStatus({ data: true })).toBe('');
  });

  it('publishes a fixed Bool command', () => {
    const publish = jest.fn();
    commandInspectionRuntime({ publish } as any, true);
    expect(publish).toHaveBeenCalledWith(
      INSPECTION_RUNTIME_COMMAND_TOPIC,
      'std_msgs/msg/Bool',
      { data: true },
    );
  });
});
