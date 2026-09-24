import { create } from 'zustand';
import { OMNI_TELEOP_TOPIC } from '../lib/teleop';
import { useCmdVelStore } from './useCmdVelStore';

export function steppedTravelSpeed(current: number, direction: -1 | 1): number {
  return Math.max(1, Math.min(15, Math.round(current * 10) + direction)) / 10;
}

export const useTravelSpeedStore = create<{
  speed: number; known: boolean; received: boolean; pending: boolean; error: string | null;
  apply: (speed: number) => void;
  reset: () => void;
}>((set, get) => ({
  speed: 0.4, known: false, received: false, pending: false, error: null,
  apply: (speed) => {
    if (!Number.isFinite(speed) || speed < 0.1 || speed > 1.5) return;
    const old = get();
    // Preserve the held stick fraction and the independent lateral/yaw axes.
    if (old.received && old.speed !== speed) {
      const x = useCmdVelStore.getState().topics[OMNI_TELEOP_TOPIC]?.['linear.x'];
      if (typeof x === 'number') {
        useCmdVelStore.getState().setAxes(OMNI_TELEOP_TOPIC, {
          'linear.x': Math.max(-1, Math.min(1, x / old.speed)) * speed,
        });
      }
    }
    set({ speed, known: true, received: true });
  },
  reset: () => set({ speed: 0.4, known: false, received: false, pending: false, error: null }),
}));
