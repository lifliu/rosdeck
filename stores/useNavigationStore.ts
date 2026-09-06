import { create } from 'zustand';
import {
  ACTIVE_NAVIGATION_STATES,
  NAVIGATION_STATE,
  type NavigationStatus,
  type SubmitNavigationGoalResponse,
  type CancelNavigationGoalResponse,
  type PoseStamped,
} from '../lib/navigation';
import type { MissionRequestEnvelope } from '../lib/autonomy-runtime';

export interface PendingNavigationSubmit extends MissionRequestEnvelope {
  managerEpoch: string;
  mapId: string;
  mapVersion: number;
  mapChecksum: string;
  targetPose: PoseStamped;
  useFinalYaw: boolean;
  speedScale: number;
}

interface NavigationStore {
  status: NavigationStatus | null;
  receivedAt: number | null;
  stale: boolean;
  submitting: boolean;
  pendingSubmit: PendingNavigationSubmit | null;
  canceling: boolean;
  activeOperationId: string;
  lastError: string | null;

  onStatus: (status: NavigationStatus, receivedAt?: number) => void;
  markStale: () => void;
  beginSubmit: () => boolean;
  setPendingSubmit: (request: PendingNavigationSubmit | null) => void;
  completeSubmit: (response: SubmitNavigationGoalResponse) => void;
  beginCancel: () => boolean;
  completeCancel: (response: CancelNavigationGoalResponse) => void;
  failCommand: (message: string) => void;
  clearError: () => void;
  resetFeed: () => void;
}

export function isNewerNavigationStatus(
  previous: NavigationStatus | null,
  incoming: NavigationStatus,
): boolean {
  if (!previous || previous.manager_epoch !== incoming.manager_epoch) return true;
  return incoming.status_sequence > previous.status_sequence;
}

export const useNavigationStore = create<NavigationStore>((set, get) => ({
  status: null,
  receivedAt: null,
  stale: true,
  submitting: false,
  pendingSubmit: null,
  canceling: false,
  activeOperationId: '',
  lastError: null,

  onStatus: (status, receivedAt = Date.now()) =>
    set((state) => {
      if (!isNewerNavigationStatus(state.status, status)) return state;
      const managerRestarted = state.status !== null &&
        state.status.manager_epoch !== status.manager_epoch;
      const active = ACTIVE_NAVIGATION_STATES.includes(status.state);
      const pendingBelongsToManager = state.pendingSubmit === null ||
        state.pendingSubmit.managerEpoch === status.manager_epoch;
      const submitAcknowledged = state.pendingSubmit !== null &&
        pendingBelongsToManager &&
        ((status.request_id === state.pendingSubmit.requestId &&
          status.request_source === state.pendingSubmit.source) ||
          (state.activeOperationId !== '' &&
            status.operation_id === state.activeOperationId)) &&
        status.operation_id !== '';
      const preserveAcceptedOperation = state.pendingSubmit !== null &&
        pendingBelongsToManager && !submitAcknowledged &&
        state.activeOperationId !== '';
      return {
        status,
        receivedAt,
        stale: false,
        // A newer heartbeat may still describe the operation before this submit.
        // Only the matching request identity or the service result releases the lock.
        submitting: submitAcknowledged ? false : state.submitting,
        pendingSubmit: submitAcknowledged || !pendingBelongsToManager
          ? null
          : state.pendingSubmit,
        // accepted 取消在终态前保持串行化；中途迟到的 EXECUTING 快照不能重新使能按钮。
        canceling: active ? state.canceling : false,
        activeOperationId: preserveAcceptedOperation
          ? state.activeOperationId
          : managerRestarted
          ? (active ? status.operation_id : '')
          : active
            ? status.operation_id
            : '',
        lastError: status.state === NAVIGATION_STATE.FAILED ||
          status.state === NAVIGATION_STATE.INTERRUPTED
          ? status.reason_text || '单点导航执行失败'
          : null,
      };
    }),

  markStale: () => set({ stale: true }),

  beginSubmit: () => {
    const state = get();
    if (state.submitting || state.canceling || state.activeOperationId) return false;
    set({ submitting: true, lastError: null });
    return true;
  },

  setPendingSubmit: (pendingSubmit) => set({ pendingSubmit }),

  completeSubmit: (response) => set((state) => ({
    submitting: false,
    // accepted is only queue admission. Keep the request identity until the
    // corresponding status arrives so an older IDLE heartbeat cannot unlock.
    pendingSubmit: response.accepted ? state.pendingSubmit : null,
    activeOperationId: response.accepted ? response.operation_id : '',
    lastError: response.accepted ? null : response.reason_text || '导航目标被拒绝',
  })),

  beginCancel: () => {
    const state = get();
    if (state.submitting || state.canceling || !state.activeOperationId) return false;
    set({ canceling: true, lastError: null });
    return true;
  },

  completeCancel: (response) => set({
    canceling: response.accepted,
    lastError: response.accepted ? null : response.reason_text || '取消导航被拒绝',
  }),

  failCommand: (lastError) => set({ submitting: false, canceling: false, lastError }),
  clearError: () => set({ lastError: null }),

  resetFeed: () => set((state) => ({
    status: null,
    receivedAt: null,
    stale: true,
    submitting: false,
    // Preserve a timed-out request envelope across a same-manager reconnect so
    // an explicit retry remains idempotent. onStatus drops it on epoch mismatch.
    canceling: false,
    activeOperationId: state.pendingSubmit ? state.activeOperationId : '',
    lastError: null,
  })),
}));
