import type { WidgetDefinition } from '../../types/layout';
import { OMNI_BASE_FRAME } from '../../lib/frames';
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
    useTwistStamped: DEFAULTS.cmdVelUseTwistStamped,
    frameId: OMNI_BASE_FRAME,
    controlScheme: 'dual',
    maxLinearVel: DEFAULTS.maxLinearVel,
    maxAngularVel: DEFAULTS.maxAngularVel,
    requireLocoMode: true,
  },
  configSchema: [
    { key: 'topic', label: 'Velocity Topic', type: 'text' },
    { key: 'useTwistStamped', label: 'Use TwistStamped', type: 'boolean' },
    { key: 'requireLocoMode', label: 'Enter VBot LOCO Mode', type: 'boolean' },
    { key: 'frameId', label: 'Frame ID', type: 'text' },
    { key: 'maxLinearVel', label: 'Max Linear Speed', type: 'slider', min: 0.1, max: 2, step: 0.1, unit: 'm/s' },
    { key: 'maxAngularVel', label: 'Max Yaw Speed', type: 'slider', min: 0.1, max: 3, step: 0.1, unit: 'rad/s' },
  ],
  component: Joystick as any,
};
