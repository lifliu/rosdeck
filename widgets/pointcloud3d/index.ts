import type { WidgetDefinition } from '../../types/layout';
import { OMNI_BASE_FRAME, OMNI_MAP_FRAME } from '../../lib/frames';
import { PointCloud3DWidget } from './PointCloud3DWidget';

export const pointCloud3DWidget: WidgetDefinition = {
  type: 'pointcloud3d',
  name: '3D Point Cloud',
  icon: 'cube-outline',
  category: 'sensor',
  supportedMessageTypes: ['sensor_msgs/msg/PointCloud2'],
  defaultConfig: {
    topic: '/cloud_registered_global',
    mapFrame: OMNI_MAP_FRAME,
    robotFrame: OMNI_BASE_FRAME,
    odomTopic: '/Odometry',
    viewMeters: 20,
  },
  configSchema: [
    {
      key: 'topic',
      label: 'Registered Point Cloud',
      type: 'topic',
      topicMessageTypes: ['sensor_msgs/msg/PointCloud2'],
    },
    {
      key: 'mapFrame',
      label: 'Map Frame',
      type: 'text',
      placeholder: OMNI_MAP_FRAME,
    },
    {
      key: 'robotFrame',
      label: 'Robot Frame',
      type: 'text',
      placeholder: OMNI_BASE_FRAME,
    },
    {
      key: 'odomTopic',
      label: 'Odometry Fallback',
      type: 'topic',
      topicMessageTypes: ['nav_msgs/msg/Odometry'],
    },
    {
      key: 'viewMeters',
      label: 'Default View Size',
      type: 'number',
      placeholder: '20',
    },
  ],
  component: PointCloud3DWidget as any,
};
