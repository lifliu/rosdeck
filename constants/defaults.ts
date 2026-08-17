import { OMNI_TELEOP_TOPIC } from '../lib/teleop';

export const DEFAULTS = {
  rosbridgePort: 9090,
  foxglovePort: 8765,
  mjpegPort: 8080,
  // Unified manual-control input consumed by cmd_vel_arbiter.
  cmdVelTopic: OMNI_TELEOP_TOPIC,
  cmdVelUseTwistStamped: true,
  cameraTopic: '/camera/image_raw/compressed',
  maxLinearVel: 0.5,
  maxAngularVel: 1.0,
  publishRateHz: 10,
  connectionTimeoutMs: 5000,
  maxReconnectAttempts: 10,
  reconnectBackoffBase: 1000,
  reconnectBackoffMax: 30000,
} as const;

// foxglove_bridge 3.2+ uses sdk.v1, while legacy 0.x bridges use websocket.v1.
// Advertising both lets the server select the version it implements.
export const FOXGLOVE_WEBSOCKET_PROTOCOLS = [
  'foxglove.sdk.v1',
  'foxglove.websocket.v1',
] as const;
