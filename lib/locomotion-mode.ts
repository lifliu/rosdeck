import type { Subscription, Transport } from './transport';
import { useLocomotionModeStore } from '../stores/useLocomotionModeStore';
import { CONTROL_CLIENT_ID } from './control-authority';

export const LOCOMOTION_COMMAND_TOPIC = '/rosdeck/locomotion_command';
export const LOCOMOTION_STATUS_TOPIC = '/rosdeck/locomotion_status';
export const LOCOMOTION_MESSAGE_TYPE = 'std_msgs/msg/String';
export const LOCOMOTION_COMMAND = { data: `loco:${CONTROL_CLIENT_ID}` } as const;

const ACK_TIMEOUT_MS = 10000;
const RETRY_DELAY_MS = 2000;
const SERVICE_NAME = '/locomotion/set_run_mode';
const SERVICE_TYPE = 'function_msgs/srv/SetRunMode';

interface ModeEntry {
  ready: boolean;
  promise: Promise<void> | null;
  error: Error | null;
  retryAfter: number;
}

let entries = new WeakMap<Transport, ModeEntry>();

function getEntry(transport: Transport): ModeEntry {
  let entry = entries.get(transport);
  if (!entry) {
    entry = { ready: false, promise: null, error: null, retryAfter: 0 };
    entries.set(transport, entry);
  }
  return entry;
}

export function isLocoModeReady(transport: Transport): boolean {
  return getEntry(transport).ready;
}

export function resetLocomotionModeState(): void {
  entries = new WeakMap();
  useLocomotionModeStore.getState().reset();
}

function requestBridgeLocoMode(transport: Transport): Promise<void> {
  return new Promise((resolve, reject) => {
    let subscription: Subscription | null = null;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      subscription?.unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(
      () => finish(new Error('Locomotion bridge did not acknowledge the request')),
      ACK_TIMEOUT_MS,
    );

    subscription = transport.subscribe(
      LOCOMOTION_STATUS_TOPIC,
      LOCOMOTION_MESSAGE_TYPE,
      (message) => {
        if (typeof message?.data !== 'string') return;
        const [result, command, ...details] = message.data.split(':');
        if (command !== 'loco') return;
        if (result === 'success') {
          finish();
        } else if (result === 'error') {
          finish(new Error(details.join(':') || 'LOCO mode switch failed'));
        }
      },
    );
    if (settled) subscription.unsubscribe();

    try {
      transport.publish(
        LOCOMOTION_COMMAND_TOPIC,
        LOCOMOTION_MESSAGE_TYPE,
        LOCOMOTION_COMMAND,
      );
    } catch (error: any) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function requestLocoMode(transport: Transport): Promise<void> {
  const topics = await transport.getTopics().catch(() => []);
  const bridgeAvailable = topics.some((topic) => topic.name === LOCOMOTION_STATUS_TOPIC);
  if (bridgeAvailable) {
    return requestBridgeLocoMode(transport);
  }

  const response = await transport.callService(SERVICE_NAME, SERVICE_TYPE, {
    target_state: 1,
    mode: 2,
    req_id: 'rosdeck',
    pre_check: false,
    has_is_traction_user_param: false,
    is_traction_user_param: false,
  });
  if (response?.success !== true) {
    throw new Error(
      response?.message || `SetRunMode failed (${response?.error_code ?? 'unknown'})`,
    );
  }
}

export function ensureLocoMode(transport: Transport): Promise<void> {
  const entry = getEntry(transport);
  if (entry.ready) return Promise.resolve();
  if (entry.promise) return entry.promise;
  if (entry.error && Date.now() < entry.retryAfter) return Promise.reject(entry.error);

  useLocomotionModeStore.getState().setStatus('switching');
  entry.promise = requestLocoMode(transport).then(() => {
    entry.ready = true;
    entry.error = null;
    entry.retryAfter = 0;
    useLocomotionModeStore.getState().setStatus('ready');
  }).catch((error: any) => {
    entry.ready = false;
    entry.error = error instanceof Error ? error : new Error(String(error));
    entry.retryAfter = Date.now() + RETRY_DELAY_MS;
    useLocomotionModeStore.getState().setStatus('error', entry.error.message);
    throw entry.error;
  }).finally(() => {
    entry.promise = null;
  });
  return entry.promise;
}
