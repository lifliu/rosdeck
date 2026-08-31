import { EventEmitter, type EventSubscription } from 'expo-modules-core';
import ExpoGamepadModule from './ExpoGamepadModule';

export type GamepadStickEvent = {
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
};

export type GamepadConnectionEvent = {
  connected: boolean;
  name: string;
};

type GamepadEvents = {
  onGamepadAxis: (event: GamepadStickEvent) => void;
  onGamepadConnection: (event: GamepadConnectionEvent) => void;
};

const emitter = new EventEmitter<GamepadEvents>(ExpoGamepadModule);

export function addAxisListener(
  listener: (event: GamepadStickEvent) => void,
): EventSubscription {
  return emitter.addListener('onGamepadAxis', listener);
}

export function addConnectionListener(
  listener: (event: GamepadConnectionEvent) => void,
): EventSubscription {
  return emitter.addListener('onGamepadConnection', listener);
}
