jest.mock('react-native', () => ({
  View: 'View',
  StyleSheet: { create: (s: Record<string, unknown>) => s },
  Platform: { OS: 'android', select: (obj: any) => obj.android || obj.default },
  Vibration: { vibrate: jest.fn() },
}));

jest.mock('react-native-gesture-handler', () => ({
  Gesture: { Pan: () => ({ onStart: jest.fn().mockReturnThis(), onUpdate: jest.fn().mockReturnThis(), onEnd: jest.fn().mockReturnThis() }) },
  GestureDetector: 'GestureDetector',
}));

jest.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  useSharedValue: jest.fn((v: number) => ({ value: v })),
  useAnimatedStyle: jest.fn((f: () => unknown) => f()),
  withSpring: jest.fn((v: number) => v),
}));

import { calculateVelocity } from '../../components/Joystick';

describe('calculateVelocity', () => {
  const radius = 60;

  it('returns zero normalized axes at center', () => {
    const { nx, ny } = calculateVelocity(0, 0, radius);
    expect(nx).toBe(0);
    expect(ny).toBe(0);
  });

  it('returns full positive Y when pushed fully forward', () => {
    const { nx, ny } = calculateVelocity(0, -radius, radius);
    expect(ny).toBeCloseTo(1);
    expect(nx).toBeCloseTo(0);
  });

  it('returns negative Y when pulled fully back', () => {
    const { ny } = calculateVelocity(0, radius, radius);
    expect(ny).toBeCloseTo(-1);
  });

  it('returns positive X when pushed fully left', () => {
    const { nx } = calculateVelocity(-radius, 0, radius);
    expect(nx).toBeCloseTo(1);
  });

  it('returns negative X when pushed fully right', () => {
    const { nx } = calculateVelocity(radius, 0, radius);
    expect(nx).toBeCloseTo(-1);
  });

  it('clamps to max values when pushed beyond radius', () => {
    const { ny } = calculateVelocity(0, -radius * 2, radius);
    expect(ny).toBe(1);
  });
});
