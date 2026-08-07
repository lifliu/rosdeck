import {
  ensureLocoMode,
  isLocoModeReady,
  LOCOMOTION_COMMAND,
  LOCOMOTION_COMMAND_TOPIC,
  LOCOMOTION_MESSAGE_TYPE,
  LOCOMOTION_STATUS_TOPIC,
  resetLocomotionModeState,
} from '../../lib/locomotion-mode';
import type { Transport } from '../../lib/transport';
import { useLocomotionModeStore } from '../../stores/useLocomotionModeStore';

function makeTransport(statusMessage: string): Transport {
  let statusCallback: ((message: any) => void) | null = null;
  const transport = {
    connect: jest.fn(),
    disconnect: jest.fn(),
    subscribe: jest.fn((topic, messageType, callback) => {
      expect(topic).toBe(LOCOMOTION_STATUS_TOPIC);
      expect(messageType).toBe(LOCOMOTION_MESSAGE_TYPE);
      statusCallback = callback;
      return { unsubscribe: jest.fn() };
    }),
    publish: jest.fn(() => statusCallback?.({ data: statusMessage })),
    callService: jest.fn(),
    getTopics: jest.fn().mockResolvedValue([
      { name: LOCOMOTION_STATUS_TOPIC, type: LOCOMOTION_MESSAGE_TYPE },
    ]),
    onStatus: jest.fn(),
    getStatus: jest.fn(),
  };
  return transport as unknown as Transport;
}

describe('VBot locomotion mode gate', () => {
  beforeEach(() => resetLocomotionModeState());

  it('coalesces requests and asks the robot bridge to enter MODE_LOCO once', async () => {
    const transport = makeTransport('success:loco');
    await Promise.all([ensureLocoMode(transport), ensureLocoMode(transport)]);

    expect(transport.publish).toHaveBeenCalledTimes(1);
    expect(transport.publish).toHaveBeenCalledWith(
      LOCOMOTION_COMMAND_TOPIC,
      LOCOMOTION_MESSAGE_TYPE,
      LOCOMOTION_COMMAND,
    );
    expect(transport.callService).not.toHaveBeenCalled();
    expect(isLocoModeReady(transport)).toBe(true);
    expect(useLocomotionModeStore.getState().status).toBe('ready');
  });

  it('does not mark the gate ready when the robot bridge reports an error', async () => {
    const transport = makeTransport('error:loco:service_not_ready');
    await expect(ensureLocoMode(transport)).rejects.toThrow('service_not_ready');
    expect(isLocoModeReady(transport)).toBe(false);
    expect(useLocomotionModeStore.getState()).toMatchObject({
      status: 'error',
      error: 'service_not_ready',
    });
  });

  it('falls back to the direct service on robots without the bridge', async () => {
    const transport = makeTransport('success:loco');
    (transport.getTopics as jest.Mock).mockResolvedValue([]);
    (transport.callService as jest.Mock).mockResolvedValue({
      success: true,
      message: 'ok',
      error_code: 0,
    });

    await expect(ensureLocoMode(transport)).resolves.toBeUndefined();
    expect(transport.publish).not.toHaveBeenCalled();
    expect(transport.callService).toHaveBeenCalledWith(
      '/locomotion/set_run_mode',
      'function_msgs/srv/SetRunMode',
      {
        target_state: 1,
        mode: 2,
        req_id: 'rosdeck',
        pre_check: false,
        has_is_traction_user_param: false,
        is_traction_user_param: false,
      },
    );
  });
});
