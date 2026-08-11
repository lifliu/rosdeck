import { create } from 'zustand';
import type { TwistField } from '../lib/ros';

export type AxisMap = Partial<Record<TwistField, number>>;

interface CmdVelState {
  topics: Record<string, AxisMap>;
  setAxes: (topic: string, values: AxisMap) => void;
  clearAxes: (topic: string, fields: TwistField[]) => void;
  clearAll: () => void;
}

export const useCmdVelStore = create<CmdVelState>((set) => ({
  topics: {},
  setAxes: (topic, values) =>
    set((s) => ({
      topics: { ...s.topics, [topic]: { ...s.topics[topic], ...values } },
    })),
  clearAxes: (topic, fields) =>
    set((s) => {
      const axes = { ...s.topics[topic] };
      fields.forEach((f) => { axes[f] = 0; });
      return { topics: { ...s.topics, [topic]: axes } };
    }),
  clearAll: () =>
    set((state) => {
      const topics: Record<string, AxisMap> = {};
      for (const [topic, axes] of Object.entries(state.topics)) {
        topics[topic] = Object.fromEntries(
          Object.keys(axes).map((field) => [field, 0]),
        ) as AxisMap;
      }
      return { topics };
    }),
}));
