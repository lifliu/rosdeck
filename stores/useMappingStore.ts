import { create } from 'zustand';

interface MappingState {
  active: boolean;
  sessionId: number;
  startSession: () => void;
  stopSession: () => void;
  reset: () => void;
}

export const useMappingStore = create<MappingState>((set) => ({
  active: false,
  sessionId: 0,
  startSession: () => set((state) => ({ active: true, sessionId: state.sessionId + 1 })),
  stopSession: () => set({ active: false }),
  reset: () => set({ active: false }),
}));
