jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() }, StyleSheet: { create: (s: any) => s },
  Text: 'Text', View: 'View', TouchableOpacity: 'TouchableOpacity',
  Platform: { OS: 'android', select: (s: any) => s.android ?? s.default },
}));

import React from 'react';
const { act, create } = require('react-test-renderer');
import { ControlAuthoritySession } from '../../components/ControlAuthority';
import { CONTROL_CLIENT_ID } from '../../lib/control-authority';
import { useRosStore } from '../../stores/useRosStore';
import { useControlAuthorityStore } from '../../stores/useControlAuthorityStore';
import { useCmdVelStore } from '../../stores/useCmdVelStore';
import type { Transport } from '../../lib/transport';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it('keeps renewals and the subscription while both sticks change, and ignores old session replies', async () => {
  jest.useFakeTimers();
  let tree: any;
  const callbacks: Array<(message: any) => void> = [];
  const unsubscribe = jest.fn();
  let finishOld: (value: any) => void = () => {};
  const old = {
    getStatus: () => 'connected',
    subscribe: jest.fn((_topic, _type, cb) => { callbacks.push(cb); return { unsubscribe }; }),
    callService: jest.fn(() => new Promise((resolve) => { finishOld = resolve; })),
  } as unknown as Transport;
  const next = { ...old, callService: jest.fn(async () => ({ accepted: true })) } as Transport;
  const active = { state: 3, base_owner_type: 1, base_client_id: CONTROL_CLIENT_ID };
  const connect = (transport: Transport) => useRosStore.setState({
    transport, connection: { status: 'connected', url: 'ws://test:8765', ros: null, error: null },
  });
  try {
    connect(old);
    await act(async () => { tree = create(<ControlAuthoritySession />); });
    await act(async () => { callbacks[0](active); });
    expect(old.callService).toHaveBeenCalledTimes(1);
    await act(async () => {
      for (let i = 0; i < 100; i++) {
        useCmdVelStore.getState().setAxes('/omni/control/teleop', { 'linear.x': i / 100 });
        useCmdVelStore.getState().setAxes('/omni/control/teleop', { 'angular.z': -i / 100 });
      }
    });
    expect(old.subscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();
    await act(async () => { connect(next); });
    await act(async () => { callbacks[1]({ state: 1 }); });
    expect(useControlAuthorityStore.getState().status).toBe('available');
    await act(async () => {
      finishOld({ accepted: false, reason_text: 'old lease expired' });
      callbacks[0](active); // a queued callback after unsubscribe
    });
    expect(useControlAuthorityStore.getState().status).toBe('available');
    await act(async () => { callbacks[1](active); });
    await act(async () => { jest.advanceTimersByTime(1000); callbacks[1](active); });
    expect(next.callService).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => { tree?.unmount(); });
    useRosStore.setState({ transport: null });
    useControlAuthorityStore.getState().reset();
    useCmdVelStore.getState().clearAll();
    jest.useRealTimers();
  }
});
