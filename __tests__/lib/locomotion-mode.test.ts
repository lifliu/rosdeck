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
    expect(LOCOMOTION_COMMAND.data).toMatch(/^loco:app-/);
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

  it('fails closed instead of bypassing the bridge on unsupported robots', async () => {
    const transport = makeTransport('success:loco');
    (transport.getTopics as jest.Mock).mockResolvedValue([]);

    await expect(ensureLocoMode(transport)).rejects.toThrow(
      'Robot Bridge locomotion control is unavailable',
    );
    expect(transport.publish).not.toHaveBeenCalled();
    expect(transport.callService).not.toHaveBeenCalled();
  });
});
