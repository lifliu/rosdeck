import { create } from 'zustand';
import {
  CONTROL_CLIENT_ID,
  type ParsedControlStatus,
} from '../lib/control-authority';

export type ControlAuthorityState =
  | 'disconnected'
  | 'detecting'
  | 'unsupported'
  | 'available'
  | 'acquiring'
  | 'acquired'
  | 'owned_by_other'
  | 'releasing'
  | 'cooldown'
  | 'error';

interface ControlAuthorityStore {
  status: ControlAuthorityState;
  ownerId: string | null;
  cooldownSeconds: number;
  error: string | null;
  reset: (status?: ControlAuthorityState) => void;
  beginAcquire: () => void;
  beginRelease: () => void;
  applyStatus: (status: ParsedControlStatus) => void;
}

export const useControlAuthorityStore = create<ControlAuthorityStore>((set) => ({
  status: 'disconnected',
  ownerId: null,
  cooldownSeconds: 0,
  error: null,

  reset: (status = 'disconnected') => set({
    status,
    ownerId: null,
    cooldownSeconds: 0,
    error: null,
  }),

  beginAcquire: () => set({
    status: 'acquiring',
    ownerId: CONTROL_CLIENT_ID,
    cooldownSeconds: 0,
    error: null,
  }),

  beginRelease: () => set((state) => ({
    status: 'releasing',
    ownerId: state.ownerId,
    error: null,
  })),

  applyStatus: (message) => {
    if (message.state === 'available' || message.state === 'unsupported') {
      set({
        status: message.state,
        ownerId: null,
        cooldownSeconds: 0,
        error: null,
      });
      return;
    }
    if (message.state === 'cooldown') {
      set({
        status: 'cooldown',
        ownerId: null,
        cooldownSeconds: message.remainingSeconds,
        error: null,
      });
      return;
    }
    if (message.state === 'error') {
      set({ status: 'error', error: `${message.action}:${message.reason}` });
      return;
    }

    if (!('ownerId' in message)) return;
    const ownedByThisApp = message.ownerId === CONTROL_CLIENT_ID;
    set({
      status: ownedByThisApp ? message.state :
        message.state === 'releasing' ? 'releasing' : 'owned_by_other',
      ownerId: message.ownerId,
      cooldownSeconds: 0,
      error: null,
    });
  },
}));

export function mobileControlIsRequired(): boolean {
  const status = useControlAuthorityStore.getState().status;
  return status !== 'disconnected' && status !== 'unsupported';
}

export function mobileControlIsAcquired(): boolean {
  const state = useControlAuthorityStore.getState();
  return state.status === 'acquired' && state.ownerId === CONTROL_CLIENT_ID;
}

export function mobileControlBlocksCommands(): boolean {
  const status = useControlAuthorityStore.getState().status;
  if (status === 'unsupported') return false;
  return !mobileControlIsAcquired();
}
