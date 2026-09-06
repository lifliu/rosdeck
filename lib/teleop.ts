import type { TopicInfo } from './transport';

export const OMNI_TELEOP_TOPIC = '/omni/control/teleop';
export const LEGACY_OMNI_TELEOP_TOPIC = '/omni/cmd_vel/teleop';
export const OMNI_ARBITER_STATUS_TOPIC = '/omni/cmd_vel/arbiter_status';
export const LEGACY_VBOT_TELEOP_TOPIC = '/vel_cmd';
export const UPSTREAM_CMD_VEL_TOPIC = '/cmd_vel';

export const TWIST_MESSAGE_TYPE = 'geometry_msgs/msg/Twist';
export const TWIST_STAMPED_MESSAGE_TYPE = 'geometry_msgs/msg/TwistStamped';
export const TELEOP_COMMAND_MESSAGE_TYPE = 'omni_robot_interfaces/msg/TeleopCommand';

export interface TeleopTarget {
  topic: string;
  useTwistStamped: boolean;
}

function isTwistTopic(topic: TopicInfo): boolean {
  return topic.type === TWIST_MESSAGE_TYPE || topic.type === TWIST_STAMPED_MESSAGE_TYPE;
}

/**
 * Select the safest product teleop input exposed by the connected ROS graph.
 *
 * 优先选择携带 client_id 的强类型人工控制入口。`/vel_cmd` 和旧版
 * `/omni/cmd_vel/teleop` 只用于尚未升级 Bridge 的兼容部署。
 */
export function selectPreferredTeleopTarget(topics: TopicInfo[]): TeleopTarget | null {
  // Foxglove's advertised channel list may omit subscription-only inputs. The
  // arbiter's published status is therefore also a product capability marker.
  if (topics.some((topic) =>
    topic.name === OMNI_ARBITER_STATUS_TOPIC && topic.type === 'std_msgs/msg/String'))
  {
    return { topic: OMNI_TELEOP_TOPIC, useTwistStamped: false };
  }

  if (topics.some((topic) =>
    topic.name === OMNI_TELEOP_TOPIC && topic.type === TELEOP_COMMAND_MESSAGE_TYPE))
  {
    return { topic: OMNI_TELEOP_TOPIC, useTwistStamped: false };
  }

  // 旧 `/omni/cmd_vel/teleop` 只有在声明标准 TwistStamped 时才可作为兼容
  // 候选；同名 Twist 不能触发从仍可工作的 VBot `/vel_cmd` 自动迁移。
  const twistTopics = topics.filter(
    (topic) => isTwistTopic(topic) &&
      !(topic.name === LEGACY_OMNI_TELEOP_TOPIC &&
      topic.type !== TWIST_STAMPED_MESSAGE_TYPE),
  );
  const find = (name: string, type?: string) => twistTopics.find(
    (topic) => topic.name === name && (!type || topic.type === type),
  );

  const selected =
    find(LEGACY_OMNI_TELEOP_TOPIC, TWIST_STAMPED_MESSAGE_TYPE) ??
    find(LEGACY_VBOT_TELEOP_TOPIC, TWIST_MESSAGE_TYPE) ??
    find(LEGACY_VBOT_TELEOP_TOPIC, TWIST_STAMPED_MESSAGE_TYPE) ??
    find(UPSTREAM_CMD_VEL_TOPIC, TWIST_STAMPED_MESSAGE_TYPE) ??
    find(UPSTREAM_CMD_VEL_TOPIC, TWIST_MESSAGE_TYPE) ??
    twistTopics.find((topic) => topic.type === TWIST_STAMPED_MESSAGE_TYPE) ??
    twistTopics[0];

  if (!selected) return null;
  return {
    topic: selected.name,
    useTwistStamped: selected.type === TWIST_STAMPED_MESSAGE_TYPE,
  };
}

export function isProductTeleopTopic(topic: string): boolean {
  return topic === OMNI_TELEOP_TOPIC || topic === LEGACY_OMNI_TELEOP_TOPIC ||
    topic === LEGACY_VBOT_TELEOP_TOPIC;
}

export function defaultUsesTwistStamped(topic: string): boolean {
  return topic === LEGACY_OMNI_TELEOP_TOPIC;
}

/**
 * The unified input is only valid behind a control-authority-aware gateway.
 * Unsupported authority is tolerated solely for legacy/custom topic profiles;
 * all other authority states require this App to own the lease.
 */
export function teleopControlIsBlocked(
  topic: string,
  authorityAcquired: boolean,
  authorityUnsupported: boolean,
): boolean {
  if (authorityAcquired) return false;
  return topic === OMNI_TELEOP_TOPIC || topic === LEGACY_OMNI_TELEOP_TOPIC ||
    !authorityUnsupported;
}

export interface TeleopAuthoritySnapshot {
  status: string;
  ownerId: string | null;
}

/**
 * Evaluate authority from a current store snapshot. Callers that publish on a
 * timer must invoke this for every message instead of retaining a React render
 * snapshot: ownership can change between two renders.
 */
export function teleopPublishIsBlocked(
  topic: string,
  authority: TeleopAuthoritySnapshot,
  clientId: string,
): boolean {
  return teleopControlIsBlocked(
    topic,
    (authority.status === 'acquired' || authority.status === 'override_acquired') &&
      authority.ownerId === clientId,
    authority.status === 'unsupported',
  );
}

/**
 * Demo mode has no robot or shared actuator owner, so it may exercise the UI
 * without a lease. Do not generalise this exception to a real bridge that
 * reports authority as unsupported: unified teleop must remain fail-closed.
 */
export function teleopPublishIsBlockedForConnection(
  topic: string,
  authority: TeleopAuthoritySnapshot,
  clientId: string,
  connectionUrl: string | null | undefined,
): boolean {
  if (connectionUrl?.startsWith('demo://')) return false;
  return teleopPublishIsBlocked(topic, authority, clientId);
}

export interface TeleopSafetyPolicy {
  requireControlAuthority: true;
  requireLocomotionMode: boolean;
}

/**
 * Product teleop inputs may never opt out of the locomotion gate. Control
 * authority remains mandatory for every joystick topic, including custom ones.
 */
export function getTeleopSafetyPolicy(
  topic: string,
  configuredLocoMode = false,
): TeleopSafetyPolicy {
  return {
    requireControlAuthority: true,
    requireLocomotionMode: isProductTeleopTopic(topic) || configuredLocoMode,
  };
}
