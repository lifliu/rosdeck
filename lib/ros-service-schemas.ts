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

const ROS_TIME_DEPENDENCY = `
================================================================================
MSG: builtin_interfaces/msg/Time
int32 sec
uint32 nanosec`;

const POSE_STAMPED_DEPENDENCIES = `${ROS_TIME_DEPENDENCY}
================================================================================
MSG: geometry_msgs/msg/PoseStamped
std_msgs/msg/Header header
geometry_msgs/msg/Pose pose
================================================================================
MSG: std_msgs/msg/Header
builtin_interfaces/msg/Time stamp
string frame_id
================================================================================
MSG: geometry_msgs/msg/Pose
geometry_msgs/msg/Point position
geometry_msgs/msg/Quaternion orientation
================================================================================
MSG: geometry_msgs/msg/Point
float64 x
float64 y
float64 z
================================================================================
MSG: geometry_msgs/msg/Quaternion
float64 x
float64 y
float64 z
float64 w`;

const CHECKPOINT_RESULT_DEPENDENCIES = `${ROS_TIME_DEPENDENCY}
================================================================================
MSG: omni_robot_interfaces/msg/CheckpointResult
std_msgs/msg/Header header
string mission_id
uint64 sequence
string checkpoint_id
string action_type
uint8 STATUS_SUCCEEDED=0
uint8 STATUS_FAILED=1
uint8 STATUS_SKIPPED=2
uint8 status
uint32 attempts
string reason
string artifact_path
string result_json
bool pose_valid
geometry_msgs/msg/Pose pose
string map_id
string map_version
string map_checksum
string software_version
================================================================================
MSG: std_msgs/msg/Header
builtin_interfaces/msg/Time stamp
string frame_id
================================================================================
MSG: geometry_msgs/msg/Pose
geometry_msgs/msg/Point position
geometry_msgs/msg/Quaternion orientation
================================================================================
MSG: geometry_msgs/msg/Point
float64 x
float64 y
float64 z
================================================================================
MSG: geometry_msgs/msg/Quaternion
float64 x
float64 y
float64 z
float64 w`;

const AUTONOMY_REASON_CONSTANTS = `uint32 REASON_NONE=0
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
uint32 REASON_NOT_RECORDING=4013
uint32 REASON_ROUTE_SAVE_FAILED=4014
uint32 REASON_EXPIRED=4015
uint32 REASON_ROUTE_ID_CONFLICT=4016`;

const NAVIGATION_REASON_CONSTANTS = `uint32 REASON_OK=0
uint32 REASON_USER_CANCELED=1
uint32 REASON_ABORTED=2
uint32 REASON_GOAL_REJECTED=3
uint32 REASON_MAP_MISMATCH=4
uint32 REASON_LOCALIZATION_LOST=5
uint32 REASON_HEARTBEAT_LOST=6
uint32 REASON_TIMEOUT=7
uint32 REASON_CONTROL_DENIED=8
uint32 REASON_STALE_SEQUENCE=9
uint32 REASON_EXPIRED=10
uint32 REASON_BUSY=11
uint32 REASON_INTERRUPTED=12`;

const ROUTE_CHECKPOINT_DEPENDENCIES = `
================================================================================
MSG: omni_robot_interfaces/msg/RouteCheckpoint
string checkpoint_id
uint32 point_index
uint8 FAILURE_FAIL_MISSION=0
uint8 FAILURE_SKIP=1
uint8 on_failure
uint32 attempts
omni_robot_interfaces/msg/RouteCheckpointAction[] actions
================================================================================
MSG: omni_robot_interfaces/msg/RouteCheckpointAction
uint8 TYPE_DWELL=0
uint8 TYPE_PHOTO=1
uint8 TYPE_RECORD=2
uint8 TYPE_RECOGNIZE=3
uint8 type
uint32 dwell_ms
uint32 photo_count
float32 record_seconds
string recognize_target`;

const LOCAL_SERVICE_SCHEMAS: Readonly<Record<string, ServiceSchemas>> = {
  'omni_robot_interfaces/srv/SetTravelSpeed': {
    request: 'float64 speed_mps',
    response: `bool accepted
float64 speed_mps
string reason`,
  },
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
string[] checkpoint_ids
string source
builtin_interfaces/msg/Time requested_at
builtin_interfaces/msg/Time deadline
string map_checksum
string route_checksum${ROS_TIME_DEPENDENCY}`,
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
  'omni_robot_interfaces/srv/GetCheckpointResults': {
    request: 'string mission_id',
    response: `omni_robot_interfaces/msg/CheckpointResult[] results${CHECKPOINT_RESULT_DEPENDENCIES}`,
  },
  'omni_robot_interfaces/srv/ListRoutes': {
    request: '# Empty request.',
    response: `string[] route_ids
string[] map_ids
string[] frame_ids
string[] created_at
string[] map_versions
string[] map_checksums
string[] route_checksums
uint32[] point_counts
float32[] distances_m`,
  },
  'omni_robot_interfaces/srv/GetRouteCheckpoints': {
    request: `string route_id`,
    response: `bool success
uint32 REASON_OK=0
uint32 REASON_NOT_FOUND=1
uint32 REASON_MALFORMED=2
uint32 reason_code
string reason_text
string route_checksum
uint32 point_count
omni_robot_interfaces/msg/RouteCheckpoint[] checkpoints${ROUTE_CHECKPOINT_DEPENDENCIES}`,
  },
  'omni_robot_interfaces/srv/UpdateRouteCheckpoints': {
    request: `string route_id
string expected_route_checksum
omni_robot_interfaces/msg/RouteCheckpoint[] checkpoints${ROUTE_CHECKPOINT_DEPENDENCIES}`,
    response: `bool accepted
uint32 REASON_OK=0
uint32 REASON_INVALID_REQUEST=1
uint32 REASON_NOT_FOUND=2
uint32 REASON_CONFLICT=3
uint32 REASON_BUSY=4
uint32 REASON_IO=5
uint32 reason_code
string reason_text
string route_checksum`,
  },
  'omni_robot_interfaces/srv/ListMaps': {
    request: '# Empty request.',
    response: `string[] map_ids
uint32[] map_versions
string[] map_checksums
string[] created_at
uint64[] size_bytes`,
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
float32 timeout_sec
builtin_interfaces/msg/Time requested_at
builtin_interfaces/msg/Time deadline
string map_checksum
string route_id${ROS_TIME_DEPENDENCY}`,
    response: `bool accepted
string operation_id
${AUTONOMY_REASON_CONSTANTS}
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
bool make_current
builtin_interfaces/msg/Time requested_at
builtin_interfaces/msg/Time deadline${ROS_TIME_DEPENDENCY}`,
    response: `bool accepted
string operation_id
${AUTONOMY_REASON_CONSTANTS}
uint32 reason_code
string reason_text
uint64 runtime_generation`,
  },
  'omni_robot_interfaces/srv/FinishRouteRecording': {
    request: `uint8 SAVE=1
uint8 DISCARD=2
string request_id
uint64 sequence
string source
builtin_interfaces/msg/Time requested_at
builtin_interfaces/msg/Time deadline
string recording_operation_id
uint8 disposition${ROS_TIME_DEPENDENCY}`,
    response: `bool accepted
string operation_id
uint64 runtime_generation
${AUTONOMY_REASON_CONSTANTS}
uint32 reason_code
string reason_text`,
  },
  'omni_robot_interfaces/srv/SubmitNavigationGoal': {
    request: `string request_id
uint64 sequence
string source
builtin_interfaces/msg/Time requested_at
builtin_interfaces/msg/Time deadline
string map_id
uint32 map_version
string map_checksum
geometry_msgs/msg/PoseStamped target_pose
bool use_final_yaw
float32 speed_scale${POSE_STAMPED_DEPENDENCIES}`,
    response: `bool accepted
string manager_epoch
string operation_id
uint64 runtime_generation
${NAVIGATION_REASON_CONSTANTS}
uint32 reason_code
string reason_text`,
  },
  'omni_robot_interfaces/srv/CancelNavigationGoal': {
    request: `string request_id
uint64 sequence
string source
builtin_interfaces/msg/Time requested_at
builtin_interfaces/msg/Time deadline
string target_operation_id${ROS_TIME_DEPENDENCY}`,
    response: `bool accepted
string manager_epoch
string cancel_operation_id
${NAVIGATION_REASON_CONSTANTS}
uint32 reason_code
string reason_text`,
  },
};

/** 返回固定服务合同；未知类型必须保持 undefined 并让调用显式失败。 */
export function getLocalServiceSchema(
  serviceType: string,
  direction: ServiceSchemaDirection,
): string | undefined {
  return LOCAL_SERVICE_SCHEMAS[serviceType]?.[direction];
}
