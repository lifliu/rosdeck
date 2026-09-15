jest.mock('react-native', () => ({
  Platform: { OS: 'android', select: (value: any) => value.android ?? value.default },
}));

import React from 'react';
// The repository includes the renderer runtime without its optional type package.
const { act, create } = require('react-test-renderer') as {
  act: (callback: () => void | Promise<void>) => Promise<void>;
  create: (element: React.ReactElement) => { unmount: () => void };
};
import { useCmdVelPublisher } from '../../hooks/useCmdVelPublisher';
import { useRosStore } from '../../stores/useRosStore';
import { useCmdVelStore } from '../../stores/useCmdVelStore';
import { useControlAuthorityStore } from '../../stores/useControlAuthorityStore';
import { resetLocomotionModeState } from '../../lib/locomotion-mode';
import type { Transport } from '../../lib/transport';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it('waits for LOCO, sends the user speed and release zero, then requests LOCO again after posture changes', async () => {
  jest.useFakeTimers();
  const subscriptions = new Map<string, (message: any) => void>();
  const transport = {
    getTopics: jest.fn(async () => [{name: '/rosdeck/locomotion_status', type: 'std_msgs/msg/String'}]),
    subscribe: jest.fn((topic: string, _type: string, callback: (message: any) => void) => {
      subscriptions.set(topic, callback);
      return { unsubscribe: () => subscriptions.delete(topic) };
    }),
    publish: jest.fn(),
  } as unknown as Transport;
  resetLocomotionModeState();
  useControlAuthorityStore.getState().reset('unsupported');
  useCmdVelStore.setState({ topics: {} });
  useRosStore.setState({ transport, connection: {
    ...useRosStore.getState().connection, ros: null,
    url: 'ws://dog1:8765', status: 'connected',
  } });
  let publisher: ReturnType<typeof useCmdVelPublisher>;
  function Harness() {
    publisher = useCmdVelPublisher('/vel_cmd', false, 'omni_base_link', true);
    return null;
  }
  let tree: ReturnType<typeof create> | undefined;
  try {
    await act(async () => { tree = create(<Harness />); });
    useCmdVelStore.getState().setAxes('/vel_cmd', {'linear.x': 0.37, 'linear.y': -0.22, 'angular.z': 0.45});
    await act(async () => { publisher!.publishNow(); });
    expect(transport.publish).toHaveBeenCalledWith('/rosdeck/locomotion_command', 'std_msgs/msg/String', expect.anything());
    expect((transport.publish as jest.Mock).mock.calls.some(([topic]) => topic === '/vel_cmd')).toBe(false);
    await act(async () => { subscriptions.get('/rosdeck/locomotion_status')!({data: 'success:loco'}); });
    expect(transport.publish).toHaveBeenLastCalledWith('/vel_cmd', 'geometry_msgs/msg/Twist', {
      linear: {x: 0.37, y: -0.22, z: 0}, angular: {x: 0, y: 0, z: 0.45},
    });
    useCmdVelStore.getState().setAxes('/vel_cmd', {'linear.x': 0, 'linear.y': 0, 'angular.z': 0});
    await act(async () => { publisher!.publishNow(); });
    expect(transport.publish).toHaveBeenLastCalledWith('/vel_cmd', 'geometry_msgs/msg/Twist', {
      linear: {x: 0, y: 0, z: 0}, angular: {x: 0, y: 0, z: 0},
    });
    await act(async () => { subscriptions.get('/rosdeck/posture_status')!({data: 'success:stand'}); });
    (transport.publish as jest.Mock).mockClear();
    useCmdVelStore.getState().setAxes('/vel_cmd', {'linear.x': 0.2});
    await act(async () => { publisher!.publishNow(); });
    expect(transport.publish).toHaveBeenCalledTimes(1);
    expect(transport.publish).toHaveBeenLastCalledWith('/rosdeck/locomotion_command', 'std_msgs/msg/String', expect.anything());
    await act(async () => { subscriptions.get('/rosdeck/locomotion_status')!({data: 'success:loco'}); });
  } finally {
    await act(async () => { tree?.unmount(); });
    useCmdVelStore.setState({ topics: {} });
    resetLocomotionModeState();
    jest.useRealTimers();
  }
});
