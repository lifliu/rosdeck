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
};

/** 返回固定服务合同；未知类型必须保持 undefined 并让调用显式失败。 */
export function getLocalServiceSchema(
  serviceType: string,
  direction: ServiceSchemaDirection,
): string | undefined {
  return LOCAL_SERVICE_SCHEMAS[serviceType]?.[direction];
}
