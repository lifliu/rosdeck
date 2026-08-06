import type { WidgetDefinition } from '../../types/layout';
import { PointCloud3DWidget } from './PointCloud3DWidget';

export const pointCloud3DWidget: WidgetDefinition = {
  type: 'pointcloud3d',
  name: '3D Point Cloud',
  icon: 'cube-outline',
  category: 'sensor',
  supportedMessageTypes: ['sensor_msgs/msg/PointCloud2'],
  defaultConfig: {
    topic: '/cloud_registered',
    mapFrame: 'map_frame',
    robotFrame: 'lidar_frame',
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
      placeholder: 'map_frame',
    },
    {
      key: 'robotFrame',
      label: 'Robot Frame',
      type: 'text',
      placeholder: 'lidar_frame',
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
