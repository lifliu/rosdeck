import { steppedTravelSpeed, useTravelSpeedStore } from '../../stores/useTravelSpeedStore';
import { useCmdVelStore } from '../../stores/useCmdVelStore';
import { OMNI_TELEOP_TOPIC } from '../../lib/teleop';

describe('backend travel speed setting', () => {
  beforeEach(() => {
    useTravelSpeedStore.getState().reset();
    useCmdVelStore.getState().clearAll();
  });
  it('steps by exact tenths and stops at 0.1 and 1.5', () => {
    expect(steppedTravelSpeed(0.4, 1)).toBe(0.5);
    expect(steppedTravelSpeed(0.5, 1)).toBe(0.6);
    expect(steppedTravelSpeed(0.1, -1)).toBe(0.1);
    expect(steppedTravelSpeed(1.5, 1)).toBe(1.5);
  });
  it('scales held forward input while preserving lateral and yaw input', () => {
    useTravelSpeedStore.getState().apply(0.4);
    useCmdVelStore.getState().setAxes(OMNI_TELEOP_TOPIC, {
      'linear.x': -0.2, 'linear.y': 0.15, 'angular.z': 0.6,
    });
    useTravelSpeedStore.getState().apply(0.6);
    expect(useCmdVelStore.getState().topics[OMNI_TELEOP_TOPIC]).toEqual({
      'linear.x': -0.3, 'linear.y': 0.15, 'angular.z': 0.6,
    });
  });
  it('rejects invalid backend values and clears old settings on reconnect', () => {
    useTravelSpeedStore.getState().apply(1.2);
    for (const bad of [NaN, Infinity, 0.0, 1.6]) useTravelSpeedStore.getState().apply(bad);
    expect(useTravelSpeedStore.getState().speed).toBe(1.2);
    useTravelSpeedStore.getState().reset();
    expect(useTravelSpeedStore.getState().known).toBe(false);
    expect(useTravelSpeedStore.getState().speed).toBe(0.4);
  });
});
