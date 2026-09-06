import { OMNI_TELEOP_TOPIC } from '../lib/teleop';

export const DEFAULTS = {
  rosbridgePort: 9090,
  foxglovePort: 8765,
  mjpegPort: 8080,
  // 携带 APP client_id 的强类型人工控制入口。
  cmdVelTopic: OMNI_TELEOP_TOPIC,
  cmdVelUseTwistStamped: false,
  // 上层客户端只订阅 omni_tf_manager 输出的规范相机话题，避免绑定仿真器或厂商原始命名。
  cameraTopic: '/omni/sensors/rgb/image/compressed',
  maxLinearVel: 0.5,
  maxAngularVel: 1.0,
  publishRateHz: 10,
  connectionTimeoutMs: 5000,
  // 重连不会在固定次数后永久停止；该值只限制指数退避级数，避免等待时间无限增长。
  maxReconnectBackoffExponent: 10,
  reconnectBackoffBase: 1000,
  reconnectBackoffMax: 30000,
} as const;

// foxglove_bridge 3.2+ uses sdk.v1, while legacy 0.x bridges use websocket.v1.
// Advertising both lets the server select the version it implements.
export const FOXGLOVE_WEBSOCKET_PROTOCOLS = [
  'foxglove.sdk.v1',
  'foxglove.websocket.v1',
] as const;
