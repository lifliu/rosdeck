import type { Transport } from './transport';

export const CONTROL_COMMAND_TOPIC = '/rosdeck/control_command';
export const CONTROL_STATUS_TOPIC = '/rosdeck/control_status';
export const CONTROL_MESSAGE_TYPE = 'std_msgs/msg/String';

export type ControlAction = 'acquire' | 'release' | 'heartbeat' | 'status';
export type ParsedControlStatus =
  | { state: 'available' | 'unsupported' }
  | { state: 'acquiring' | 'acquired' | 'releasing'; ownerId: string }
  | { state: 'cooldown'; remainingSeconds: number }
  | { state: 'error'; action: string; clientId: string; reason: string };

export const CONTROL_CLIENT_ID = `app-${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 10)}`;

export function parseControlStatus(message: any): ParsedControlStatus | null {
  if (typeof message?.data !== 'string') return null;
  const [state, value, ...details] = message.data.split(':');
  if (state === 'available' || state === 'unsupported') return { state };
  if ((state === 'acquiring' || state === 'acquired' || state === 'releasing') && value) {
    return { state, ownerId: value };
  }
  if (state === 'cooldown') {
    const remainingSeconds = Number.parseInt(value ?? '', 10);
    if (!Number.isFinite(remainingSeconds)) return null;
    return { state, remainingSeconds: Math.max(0, remainingSeconds) };
  }
  if (state === 'error' && value) {
    const [clientId, ...reason] = details;
    if (!clientId) return null;
    return { state, action: value, clientId, reason: reason.join(':') || 'unknown_error' };
  }
  return null;
}

export function publishControlAction(
  transport: Transport,
  action: ControlAction,
): void {
  transport.publish(CONTROL_COMMAND_TOPIC, CONTROL_MESSAGE_TYPE, {
    data: `${action}:${CONTROL_CLIENT_ID}`,
  });
}

export function bestEffortReleaseControl(transport: Transport | null): void {
  if (!transport || transport.getStatus() !== 'connected') return;
  try {
    publishControlAction(transport, 'release');
  } catch {
    // The Bridge heartbeat timeout is the second safety net when the socket is
    // already gone and an explicit release cannot be delivered.
  }
}
