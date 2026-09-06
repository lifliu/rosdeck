import type { WidgetDefinition } from '../../types/layout';
import { OMNI_BASE_FRAME, OMNI_MAP_FRAME, OMNI_ODOM_FRAME } from '../../lib/frames';
import { MapWidget } from './MapWidget';

export const mapWidget: WidgetDefinition = {
  type: 'map',
  name: 'Map',
  icon: 'map-outline',
  category: 'nav',
  supportedMessageTypes: ['nav_msgs/msg/OccupancyGrid', 'sensor_msgs/msg/LaserScan'],
  defaultConfig: {
    topic: '/map',
    scanTopic: '/scan',
    mapFrame: OMNI_MAP_FRAME,
    odomFrame: OMNI_ODOM_FRAME,
    robotFrame: OMNI_BASE_FRAME,
    flipIndicator: false,
    globalCostmapTopic: '',
    localCostmapTopic: '',
    costmapOpacity: 0.5,
    updateRate: 0,
  },
  configSchema: [
    {
      key: 'topic',
      label: 'Map Topic',
      type: 'topic',
      topicMessageTypes: ['nav_msgs/msg/OccupancyGrid'],
    },
    {
      key: 'scanTopic',
      label: 'LaserScan Topic',
      type: 'topic',
      topicMessageTypes: ['sensor_msgs/msg/LaserScan'],
    },
    { key: 'mapFrame', label: 'Map Frame', type: 'text', placeholder: OMNI_MAP_FRAME },
    { key: 'odomFrame', label: 'Odom Frame', type: 'text', placeholder: OMNI_ODOM_FRAME },
    { key: 'robotFrame', label: 'Robot Frame', type: 'text', placeholder: OMNI_BASE_FRAME },
    { key: 'flipIndicator', label: 'Flip Robot Indicator', type: 'boolean' },
    {
      key: 'globalCostmapTopic',
      label: 'Global Costmap Topic',
      type: 'topic',
      topicMessageTypes: ['nav_msgs/msg/OccupancyGrid'],
    },
    {
      key: 'localCostmapTopic',
      label: 'Local Costmap Topic',
      type: 'topic',
      topicMessageTypes: ['nav_msgs/msg/OccupancyGrid'],
    },
    {
      key: 'updateRate',
      label: 'Max Update Rate',
      type: 'select',
      options: [
        { label: 'Robot rate', value: 0 },
        { label: '30 Hz', value: 30 },
        { label: '20 Hz', value: 20 },
        { label: '10 Hz', value: 10 },
        { label: '5 Hz', value: 5 },
      ],
    },
  ],
  component: MapWidget as any,
};
