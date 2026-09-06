import type { Transport } from './transport';

export const CONTROL_AUTHORITY_SERVICE = '/omni/control/authority';
export const CONTROL_AUTHORITY_SERVICE_TYPE =
  'omni_robot_interfaces/srv/ControlAuthority';
export const CONTROL_AUTHORITY_STATUS_TOPIC = '/omni/control/authority/status';
export const CONTROL_AUTHORITY_STATUS_TYPE =
  'omni_robot_interfaces/msg/ControlAuthorityStatus';

// Bridge 每 500 ms 发布一次控制权心跳；2 秒可容忍短暂调度抖动，同时
// 保证租约状态丢失时 APP 先于 5 秒租约上限收紧所有控制入口。
export const CONTROL_AUTHORITY_STATUS_STALE_MS = 2000;

export const CONTROL_AUTHORITY_OPERATION = {
  ACQUIRE: 0,
  RELEASE: 1,
  RENEW: 2,
} as const;
export const CONTROL_AUTHORITY_OWNER_APP = 1;
export const CONTROL_AUTHORITY_LEASE_SEC = 5;
export const CONTROL_AUTHORITY_STATE = {
  UNSUPPORTED: 0,
  AVAILABLE: 1,
  ACQUIRING: 2,
  ACTIVE: 3,
  RELEASING: 4,
  COOLDOWN: 5,
  ERROR: 6,
} as const;

export type ControlAction = 'acquire' | 'release' | 'renew';
export interface ControlAuthorityResponse {
  accepted: boolean;
  activeOwnerType: number;
  activeClientId: string;
  reasonCode: number;
  reasonText: string;
}
export type ParsedControlStatus =
  | { state: 'available' | 'unsupported' }
  | { state: 'acquiring' | 'acquired' | 'releasing'; ownerId: string }
  | { state: 'override_available'; baseOwnerId: string }
  | { state: 'override_acquired'; ownerId: string; baseOwnerId: string }
  | { state: 'cooldown'; remainingSeconds: number }
  | { state: 'error'; action: string; clientId: string; reason: string };

export const CONTROL_CLIENT_ID = `app-${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 10)}`;

export interface ControlAuthorityStatusWatchdog {
  arm: () => void;
  dispose: () => void;
}

/** 创建可重置的控制权心跳看门狗，便于 React 生命周期和单元测试共用。 */
export function createControlAuthorityStatusWatchdog(
  onStale: () => void,
  staleMs = CONTROL_AUTHORITY_STATUS_STALE_MS,
): ControlAuthorityStatusWatchdog {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    arm: () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(onStale, staleMs);
    },
    dispose: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * 将 Bridge typed 快照映射成现有 UI 状态。base owner 与 APP 人工覆盖必须
 * 分开判断；Mission 持有基础租约不代表手机被锁死。
 */
export function parseTypedControlStatus(message: any): ParsedControlStatus | null {
  const state = Number(field(message, 'state'));
  const baseOwnerType = Number(field(message, 'base_owner_type') ?? 0);
  const baseClientId = typeof field(message, 'base_client_id') === 'string'
    ? field(message, 'base_client_id') as string
    : '';
  const overrideActive = field(message, 'manual_override_active') === true;
  const overrideClientId = typeof field(message, 'manual_override_client_id') === 'string'
    ? field(message, 'manual_override_client_id') as string
    : '';

  if (state === CONTROL_AUTHORITY_STATE.UNSUPPORTED) return { state: 'unsupported' };
  if (state === CONTROL_AUTHORITY_STATE.AVAILABLE) return { state: 'available' };
  if (state === CONTROL_AUTHORITY_STATE.COOLDOWN) {
    const seconds = Number(field(message, 'cooldown_remaining_sec') ?? 0);
    return {
      state: 'cooldown',
      remainingSeconds: Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : 0,
    };
  }
  if (state === CONTROL_AUTHORITY_STATE.ERROR) {
    const reason = field(message, 'reason_text');
    return {
      state: 'error',
      action: 'status',
      clientId: CONTROL_CLIENT_ID,
      reason: typeof reason === 'string' && reason ? reason : 'authority_state_error',
    };
  }
  if (state === CONTROL_AUTHORITY_STATE.ACQUIRING && baseClientId) {
    return { state: 'acquiring', ownerId: baseClientId };
  }
  if (state === CONTROL_AUTHORITY_STATE.RELEASING && baseClientId) {
    return { state: 'releasing', ownerId: baseClientId };
  }
  if (state !== CONTROL_AUTHORITY_STATE.ACTIVE || !baseClientId) return null;

  if (baseOwnerType === CONTROL_AUTHORITY_OWNER_APP) {
    return { state: 'acquired', ownerId: baseClientId };
  }
  // RobotState.AUTHORITY_MISSION=2。此时手机只操作覆盖租约，基础 owner 不变。
  if (baseOwnerType === 2) {
    if (overrideActive && overrideClientId) {
      return {
        state: 'override_acquired',
        ownerId: overrideClientId,
        baseOwnerId: baseClientId,
      };
    }
    return { state: 'override_available', baseOwnerId: baseClientId };
  }
  return { state: 'acquired', ownerId: baseClientId };
}

/** 仅供尚未升级 typed 状态的诊断工具解析旧 Bridge 字符串。 */
export function parseControlStatus(message: any): ParsedControlStatus | null {
  if (typeof message?.data !== 'string') return null;
  const [state, value, ...details] = message.data.split(':');
  if (state === 'available' || state === 'unsupported') return { state };
  if ((state === 'acquiring' || state === 'acquired' || state === 'releasing') && value) {
    return { state, ownerId: value };
  }
  if (state === 'override_available' && value) {
    return { state, baseOwnerId: value };
  }
  if (state === 'override_acquired' && value && details[0]) {
    return { state, ownerId: value, baseOwnerId: details[0] };
  }
  if (state === 'cooldown') {
    const remainingSeconds = Number.parseInt(value ?? '', 10);
    if (!Number.isFinite(remainingSeconds)) return null;
    return { state, remainingSeconds: Math.max(0, remainingSeconds) };
  }
  if (state === 'error' && value) {
    const [clientId, ...reason] = details;
    if (!clientId) return null;
    return { state, action: value, clientId, reason: reason.join(':') || 'unknown_error' };
  }
  return null;
}

function field(obj: any, name: string): unknown {
  const camel = name.replace(/_([a-z])/g, (_match, character: string) =>
    character.toUpperCase());
  return obj?.[name] ?? obj?.[camel];
}

/**
 * 请求 Bridge 切换或续租 APP 控制权。
 *
 * Mission 导航期间同一个 ACQUIRE 会创建人工覆盖租约，不会抢走 Mission 的
 * 基础 SDK owner；具体语义由 Bridge 根据当前权威状态决定。
 */
export async function requestControlAuthority(
  transport: Transport,
  action: ControlAction,
  reason = 'app_control_ui',
): Promise<ControlAuthorityResponse> {
  const operation = action === 'acquire'
    ? CONTROL_AUTHORITY_OPERATION.ACQUIRE
    : action === 'release'
      ? CONTROL_AUTHORITY_OPERATION.RELEASE
      : CONTROL_AUTHORITY_OPERATION.RENEW;
  const raw = await transport.callService(
    CONTROL_AUTHORITY_SERVICE,
    CONTROL_AUTHORITY_SERVICE_TYPE,
    {
      op: operation,
      owner_type: CONTROL_AUTHORITY_OWNER_APP,
      client_id: CONTROL_CLIENT_ID,
      lease_sec: CONTROL_AUTHORITY_LEASE_SEC,
      reason,
    },
  );
  return {
    accepted: field(raw, 'accepted') === true,
    activeOwnerType: Number(field(raw, 'active_owner_type') ?? 0),
    activeClientId: typeof field(raw, 'active_client_id') === 'string'
      ? field(raw, 'active_client_id') as string
      : '',
    reasonCode: Number(field(raw, 'reason_code') ?? 0),
    reasonText: typeof field(raw, 'reason_text') === 'string'
      ? field(raw, 'reason_text') as string
      : '',
  };
}

export function bestEffortReleaseControl(transport: Transport | null): void {
  if (!transport || transport.getStatus() !== 'connected') return;
  void requestControlAuthority(transport, 'release', 'app_background')
    .catch(() => {
      // WebSocket 已断开时 Service 可能无法送达；Bridge 的短租约超时仍是第二道
      // 安全网，APP 后台切换绝不能阻塞 React Native 生命周期。
    });
}
