import type { WidgetDefinition } from '../../types/layout';
import { Joystick } from '../../components/Joystick';
import { DEFAULTS } from '../../constants/defaults';

export const joystickWidget: WidgetDefinition = {
  type: 'joystick',
  name: 'Joystick',
  icon: 'game-controller-outline',
  category: 'control',
  supportedMessageTypes: [],
  defaultConfig: {
    topic: DEFAULTS.cmdVelTopic,
    useTwistStamped: false,
    frameId: 'base_link',
    xAxisGroup: 'angular',
    xAxisComponent: 'z',
    xAxisScale: 1.0,
    yAxisGroup: 'linear',
    yAxisComponent: 'x',
    yAxisScale: 0.5,
    gamepadStick: 'auto',
    requireLocoMode: true,
  },
  configSchema: [
    { key: 'topic', label: 'Velocity Topic', type: 'text' },
    { key: 'useTwistStamped', label: 'Use TwistStamped', type: 'boolean' },
    { key: 'requireLocoMode', label: 'Enter VBot LOCO Mode', type: 'boolean' },
    { key: 'frameId', label: 'Frame ID', type: 'text' },
    { key: 'axisMapping', label: 'Axis Mapping', type: 'axis-mapping' },
    { key: 'gamepadStick', label: 'Gamepad Stick', type: 'select',
      options: [
        { label: 'Auto', value: 'auto' },
        { label: 'Left Stick', value: 'left' },
        { label: 'Right Stick', value: 'right' },
        { label: 'None', value: 'none' },
      ] },
  ],
  component: Joystick as any,
};
