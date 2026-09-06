/**
 * Foxglove ROS 2 服务的本地 CDR schema 兜底表。
 *
 * 部分 ROS 2 Humble 版本的 foxglove_bridge 只发布服务名称和类型，不附带
 * request/response schema。此时 APP 仍必须按服务的真实 IDL 编解码 CDR，不能
 * 退回 JSON，也不能猜测字段布局。这里只登记 APP 实际调用的固定服务合同；新增
 * 服务时必须同步 IDL 与传输层测试。
 */

type ServiceSchemas = Readonly<{
  request: string;
  response: string;
}>;

export type ServiceSchemaDirection = 'request' | 'response';

const LOCAL_SERVICE_SCHEMAS: Readonly<Record<string, ServiceSchemas>> = {
  'std_srvs/srv/Trigger': {
    // 空请求仍需生成 ROS 2 CDR encapsulation header，因此保留一个非字段注释。
    request: '# Empty request.',
    response: `bool success
string message`,
  },
  'function_msgs/srv/SetRunMode': {
    request: `uint8 target_state
uint8 mode
string req_id
bool pre_check
bool has_is_traction_user_param
bool is_traction_user_param`,
    response: `bool success
string message
int32 error_code`,
  },
  'omni_robot_interfaces/srv/ControlAuthority': {
    request: `uint8 OP_ACQUIRE=0
uint8 OP_RELEASE=1
uint8 OP_RENEW=2
uint8 op
uint8 owner_type
string client_id
float32 lease_sec
string reason`,
    response: `bool accepted
uint8 active_owner_type
string active_client_id
uint32 reason_code
string reason_text`,
  },
  'omni_robot_interfaces/srv/DispatchMission': {
    request: `string mission_id
string request_id
uint64 sequence
string map_id
string map_version
string route_id
string[] checkpoint_ids`,
    response: `bool accepted
uint32 reason_code
string reason_text
string mission_id`,
  },
  'omni_robot_interfaces/srv/MissionControl': {
    request: `uint8 CMD_PAUSE=0
uint8 CMD_RESUME=1
uint8 CMD_CANCEL=2
uint8 command
string mission_id
string request_id
uint64 sequence`,
    response: `bool accepted
uint32 reason_code
string reason_text`,
  },
  'omni_robot_interfaces/srv/ListRoutes': {
    request: '# Empty request.',
    response: `string[] route_ids
string[] map_ids
string[] frame_ids
string[] created_at`,
  },
  'omni_robot_interfaces/srv/SetAutonomyMode': {
    request: `uint8 MODE_IDLE=0
uint8 MODE_MAPPING=1
uint8 MODE_LOCALIZATION_READY=2
uint8 MODE_SINGLE_POINT_READY=3
uint8 MODE_INSPECTION_READY=4
uint8 MODE_ROUTE_RECORDING=5
string request_id
uint64 sequence
string source
uint8 desired_mode
string map_id
uint32 map_version
string mapping_session_id
float32 initial_x
float32 initial_y
float32 initial_z
float32 initial_yaw
float32 timeout_sec`,
    response: `bool accepted
string operation_id
uint32 REASON_NONE=0
uint32 REASON_INVALID_REQUEST=4000
uint32 REASON_STALE_SEQUENCE=4001
uint32 REASON_UNSUPPORTED_MODE=4002
uint32 REASON_BUSY=4003
uint32 REASON_EXTERNAL_CONFLICT=4004
uint32 REASON_MAP_REQUIRED=4005
uint32 REASON_MAP_MISMATCH=4006
uint32 REASON_SLAM_UNAVAILABLE=4007
uint32 REASON_PLANNER_UNAVAILABLE=4008
uint32 REASON_OPERATION_FAILED=4009
uint32 REASON_NOT_MAPPING=4010
uint32 REASON_SAVE_FAILED=4011
uint32 REASON_TIMEOUT=4012
uint32 reason_code
string reason_text
uint64 runtime_generation`,
  },
  'omni_robot_interfaces/srv/FinishMapping': {
    request: `uint8 SAVE=1
uint8 DISCARD=2
string request_id
uint64 sequence
string source
uint8 disposition
string map_id
string calibration_hash
bool make_current`,
    response: `bool accepted
string operation_id
uint32 REASON_NONE=0
uint32 REASON_INVALID_REQUEST=4000
uint32 REASON_STALE_SEQUENCE=4001
uint32 REASON_UNSUPPORTED_MODE=4002
uint32 REASON_BUSY=4003
uint32 REASON_EXTERNAL_CONFLICT=4004
uint32 REASON_MAP_REQUIRED=4005
uint32 REASON_MAP_MISMATCH=4006
uint32 REASON_SLAM_UNAVAILABLE=4007
uint32 REASON_PLANNER_UNAVAILABLE=4008
uint32 REASON_OPERATION_FAILED=4009
uint32 REASON_NOT_MAPPING=4010
uint32 REASON_SAVE_FAILED=4011
uint32 REASON_TIMEOUT=4012
uint32 reason_code
string reason_text
uint64 runtime_generation`,
  },
};

/** 返回固定服务合同；未知类型必须保持 undefined 并让调用显式失败。 */
export function getLocalServiceSchema(
  serviceType: string,
  direction: ServiceSchemaDirection,
): string | undefined {
  return LOCAL_SERVICE_SCHEMAS[serviceType]?.[direction];
}
