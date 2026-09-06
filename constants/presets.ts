import { createWidgetNode, createSplitNode, type LayoutNode, type SavedLayout } from '../types/layout';
import { DEFAULTS } from './defaults';
import { OMNI_BASE_FRAME, OMNI_MAP_FRAME } from '../lib/frames';

export interface PresetTemplate {
  id: string;
  name: string;
  buildTree: () => LayoutNode;
}

const createDualJoystick = () => createWidgetNode('joystick', {
  topic: DEFAULTS.cmdVelTopic,
  useTwistStamped: DEFAULTS.cmdVelUseTwistStamped,
  requireLocoMode: true,
  frameId: OMNI_BASE_FRAME,
  controlScheme: 'dual',
  maxLinearVel: DEFAULTS.maxLinearVel,
  maxAngularVel: DEFAULTS.maxAngularVel,
});

export const PRESET_TEMPLATES: PresetTemplate[] = [
  {
    id: 'mapping-3d',
    name: '3D Mapping',
    buildTree: () =>
      createSplitNode('vertical',
        createWidgetNode('pointcloud3d', {
          topic: '/cloud_registered_global',
          mapFrame: OMNI_MAP_FRAME,
          robotFrame: OMNI_BASE_FRAME,
          odomTopic: '/Odometry',
          viewMeters: 20,
        }),
        createDualJoystick(),
        0.72,
      ),
  },
  {
    id: 'drive',
    name: 'Drive',
    buildTree: createDualJoystick,
  },
  {
    id: 'drive-camera',
    name: 'Drive + Camera',
    buildTree: () =>
      createSplitNode('vertical',
        createWidgetNode('camera', { topic: DEFAULTS.cameraTopic, source: 'transport', mjpegPort: DEFAULTS.mjpegPort, maxFps: 10 }),
        createDualJoystick(),
        0.6
      ),
  },
  {
    id: 'camera-only',
    name: 'Camera Only',
    buildTree: () => createWidgetNode('camera', { topic: DEFAULTS.cameraTopic, source: 'transport', mjpegPort: DEFAULTS.mjpegPort, maxFps: 10 }),
  },
  {
    id: 'nav',
    name: 'Nav',
    buildTree: () =>
      createSplitNode('vertical',
        createWidgetNode('map', { topic: '/map' }),
        createDualJoystick(),
        0.6
      ),
  },
  {
    id: 'dashboard',
    name: 'Dashboard',
    buildTree: () =>
      createSplitNode('horizontal',
        createSplitNode('vertical',
          createWidgetNode('map', { topic: '/map', scanTopic: '/scan', odomTopic: '/odom' }),
          createSplitNode('vertical',
            createWidgetNode('battery', { topic: '/battery_state' }),
            createWidgetNode('diagnostics', { topic: '/diagnostics' }),
            0.5
          ),
          0.6
        ),
        createSplitNode('vertical',
          createWidgetNode('camera', { topic: DEFAULTS.cameraTopic, source: 'transport', mjpegPort: DEFAULTS.mjpegPort, maxFps: 10 }),
          createSplitNode('vertical',
            createWidgetNode('chart', {
              series: [
                { topic: '/battery_state', messageType: 'sensor_msgs/msg/BatteryState', field: 'voltage', label: 'Voltage', color: '#4A9EFF' },
                { topic: '/odom', messageType: 'nav_msgs/msg/Odometry', field: 'twist.twist.linear.x', label: 'Lin Vel', color: '#34D399' },
              ],
              windowSec: 30,
            }),
            createDualJoystick(),
            0.5
          ),
          0.35
        ),
        0.6
      ),
  },
];

export function buildDefaultLayouts(): SavedLayout[] {
  return PRESET_TEMPLATES.map((preset) => ({
    id: preset.id,
    name: preset.name,
    tree: preset.buildTree(),
  }));
}
