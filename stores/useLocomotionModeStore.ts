import { create } from 'zustand';

export type LocomotionModeStatus = 'idle' | 'switching' | 'ready' | 'error';

interface LocomotionModeState {
  status: LocomotionModeStatus;
  error: string | null;
  setStatus: (status: LocomotionModeStatus, error?: string | null) => void;
  reset: () => void;
}

export const useLocomotionModeStore = create<LocomotionModeState>((set) => ({
  status: 'idle',
  error: null,
  setStatus: (status, error = null) => set({ status, error }),
  reset: () => set({ status: 'idle', error: null }),
}));
