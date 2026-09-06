import { create } from 'zustand';
import {
  AUTONOMY_MODE,
  AUTONOMY_PHASE,
  type AutonomyMode,
  type AutonomyCommandResponse,
  type AutonomyRuntimeStatus,
} from '../lib/autonomy-runtime';

export type AutonomyRuntimeCommand =
  | 'set_mode'
  | 'finish_mapping'
  | 'finish_route_recording';

export interface PendingAutonomyCommand {
  kind: AutonomyRuntimeCommand;
  desiredMode?: AutonomyMode;
  operationId?: string;
}

interface AutonomyRuntimeStore {
  status: AutonomyRuntimeStatus | null;
  receivedAt: number | null;
  stale: boolean;
  pendingCommand: PendingAutonomyCommand | null;
  mappingTargetId: string;
  routeRecordingOperationId: string;
  lastOperationId: string;
  lastError: string | null;

  onStatus: (status: AutonomyRuntimeStatus, receivedAt?: number) => void;
  markStale: () => void;
  beginCommand: (command: PendingAutonomyCommand) => boolean;
  completeCommand: (response: AutonomyCommandResponse) => void;
  failCommand: (message: string) => void;
  clearError: () => void;
  setMappingTargetId: (mapId: string) => void;
  resetFeed: () => void;
}

/**
 * 同一 Manager 实例内，只接受单调递增的状态序号。
 * WebSocket 重连时可能先送达缓存快照，再送达新心跳，此保护可防止按钮倒退。
 */
export function isNewerRuntimeStatus(
  previous: AutonomyRuntimeStatus | null,
  incoming: AutonomyRuntimeStatus,
): boolean {
  if (!previous) return true;
  if (previous.manager_epoch !== incoming.manager_epoch) return true;
  return incoming.status_sequence > previous.status_sequence;
}

export const useAutonomyRuntimeStore = create<AutonomyRuntimeStore>((set, get) => ({
  status: null,
  receivedAt: null,
  stale: true,
  pendingCommand: null,
  mappingTargetId: '',
  routeRecordingOperationId: '',
  lastOperationId: '',
  lastError: null,

  onStatus: (status, receivedAt = Date.now()) =>
    set((state) => {
      if (!isNewerRuntimeStatus(state.status, status)) return state;
      const managerRestarted = state.status !== null &&
        state.status.manager_epoch !== status.manager_epoch;
      const runtimeFailed = status.phase === AUTONOMY_PHASE.ERROR ||
        status.phase === AUTONOMY_PHASE.CONFLICT;
      const pending = managerRestarted ? null : state.pendingCommand;
      const operationMatches = Boolean(pending?.operationId) &&
        pending?.operationId === status.operation_id;
      const setModeFinished = pending?.kind === 'set_mode' && operationMatches && (
        runtimeFailed ||
        (pending.desiredMode === status.mode && (
          status.phase === AUTONOMY_PHASE.READY ||
          (status.mode === AUTONOMY_MODE.IDLE && status.phase === AUTONOMY_PHASE.IDLE)
        ))
      );
      const finishMappingFinished = pending?.kind === 'finish_mapping' && operationMatches && (
        runtimeFailed ||
        (status.mode !== AUTONOMY_MODE.MAPPING && (
          status.phase === AUTONOMY_PHASE.IDLE || status.phase === AUTONOMY_PHASE.READY
        ))
      );
      const finishRouteRecordingFinished = pending?.kind === 'finish_route_recording' &&
        operationMatches && (
          runtimeFailed ||
          (status.mode !== AUTONOMY_MODE.ROUTE_RECORDING && (
            status.phase === AUTONOMY_PHASE.IDLE || status.phase === AUTONOMY_PHASE.READY
          ))
        );
      const commandFinished = setModeFinished || finishMappingFinished ||
        finishRouteRecordingFinished;
      const retainedRecordingOperationId = managerRestarted
        ? ''
        : state.routeRecordingOperationId;
      const routeRecordingOperationId = status.recording_operation_id || (
        status.mode === AUTONOMY_MODE.ROUTE_RECORDING
          ? retainedRecordingOperationId || (
            status.phase === AUTONOMY_PHASE.READY ? status.operation_id : ''
          )
          : ''
      );
      return {
        status,
        receivedAt,
        stale: false,
        // Manager 重启意味着上一进程内的 operation_id 和未完成请求都已失效。
        lastOperationId: managerRestarted ? '' : state.lastOperationId,
        // Service 的 accepted 仅表示入队；必须等相同 operation_id 的终态快照。
        pendingCommand: commandFinished ? null : pending,
        mappingTargetId: finishMappingFinished && !runtimeFailed
          ? ''
          : managerRestarted ? '' : state.mappingTargetId,
        // FinishRouteRecording 会产生自己的 operation_id；录制会话 ID 必须单独
        // 保留，保存失败后再次 DISCARD 仍只能指向原始录制会话。
        routeRecordingOperationId,
        // reason_text 在 STARTING 阶段也可用于进度说明，只有失败终态才是错误。
        lastError: runtimeFailed ? status.reason_text || '自主运行时状态异常' : null,
      };
    }),

  markStale: () => set({ stale: true }),

  beginCommand: (command) => {
    if (get().pendingCommand !== null) return false;
    set({ pendingCommand: command, lastError: null });
    return true;
  },

  completeCommand: (response) =>
    set((state) => ({
      pendingCommand: response.accepted && state.pendingCommand
        ? { ...state.pendingCommand, operationId: response.operation_id }
        : null,
      lastOperationId: response.accepted ? response.operation_id : state.lastOperationId,
      lastError: response.accepted ? null : response.reason_text || '运行时拒绝了请求',
    })),

  failCommand: (message) => set({ pendingCommand: null, lastError: message }),
  clearError: () => set({ lastError: null }),
  setMappingTargetId: (mappingTargetId) => set({ mappingTargetId }),

  resetFeed: () =>
    set({
      status: null,
      receivedAt: null,
      stale: true,
      pendingCommand: null,
      // 连接可能切换到另一台机器人，不能把上一设备的地图目标带入新会话。
      mappingTargetId: '',
      routeRecordingOperationId: '',
      lastOperationId: '',
      lastError: null,
    }),
}));
