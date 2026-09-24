import {
  CONTROL_AUTHORITY_OPERATION,
  CONTROL_AUTHORITY_OWNER_APP,
  CONTROL_AUTHORITY_SERVICE,
  CONTROL_AUTHORITY_SERVICE_TYPE,
  CONTROL_AUTHORITY_STATE,
  CONTROL_AUTHORITY_STATUS_TOPIC,
  CONTROL_AUTHORITY_STATUS_TYPE,
  CONTROL_AUTHORITY_STATUS_STALE_MS,
  createControlAuthorityStatusWatchdog,
  parseControlStatus,
  parseTypedControlStatus,
  requestControlAuthority,
} from '../../lib/control-authority';
import type { Transport } from '../../lib/transport';

describe('mobile control authority protocol', () => {
  it('uses typed Bridge command and status contracts', () => {
    expect(CONTROL_AUTHORITY_SERVICE).toBe('/omni/control/authority');
    expect(CONTROL_AUTHORITY_SERVICE_TYPE).toBe(
      'omni_robot_interfaces/srv/ControlAuthority',
    );
    expect(CONTROL_AUTHORITY_STATUS_TOPIC).toBe('/omni/control/authority/status');
    expect(CONTROL_AUTHORITY_STATUS_TYPE).toBe(
      'omni_robot_interfaces/msg/ControlAuthorityStatus',
    );
  });

  it('distinguishes the Mission base lease from this APP manual override', () => {
    expect(parseTypedControlStatus({
      state: CONTROL_AUTHORITY_STATE.ACTIVE,
      base_owner_type: 2,
      base_client_id: 'mission-42',
      manual_override_active: false,
    })).toEqual({ state: 'override_available', baseOwnerId: 'mission-42' });

    expect(parseTypedControlStatus({
      state: CONTROL_AUTHORITY_STATE.ACTIVE,
      base_owner_type: 2,
      base_client_id: 'mission-42',
      manual_override_active: true,
      manual_override_client_id: 'app-phone',
    })).toEqual({
      state: 'override_acquired',
      ownerId: 'app-phone',
      baseOwnerId: 'mission-42',
    });
  });

  it('normalizes typed lifecycle and cooldown states', () => {
    expect(parseTypedControlStatus({
      state: CONTROL_AUTHORITY_STATE.ACQUIRING,
      base_owner_type: 1,
      base_client_id: 'app-phone',
    })).toEqual({ state: 'acquiring', ownerId: 'app-phone' });
    expect(parseTypedControlStatus({
      state: CONTROL_AUTHORITY_STATE.COOLDOWN,
      cooldown_remaining_sec: 2.2,
    })).toEqual({ state: 'cooldown', remainingSeconds: 3 });
    expect(parseTypedControlStatus({ state: 99 })).toBeNull();
  });

  it('sends APP acquire and renew through the typed authority contract', async () => {
    const callService = jest.fn().mockResolvedValue({
      accepted: true,
      active_owner_type: CONTROL_AUTHORITY_OWNER_APP,
      active_client_id: 'app-phone',
      reason_code: 0,
      reason_text: 'ok',
    });
    const transport = { callService } as unknown as Transport;

    await expect(requestControlAuthority(transport, 'acquire', 'test')).resolves.toEqual({
      accepted: true,
      activeOwnerType: CONTROL_AUTHORITY_OWNER_APP,
      activeClientId: 'app-phone',
      reasonCode: 0,
      reasonText: 'ok',
    });
    expect(callService).toHaveBeenCalledWith(
      CONTROL_AUTHORITY_SERVICE,
      CONTROL_AUTHORITY_SERVICE_TYPE,
      expect.objectContaining({
        op: CONTROL_AUTHORITY_OPERATION.ACQUIRE,
        owner_type: CONTROL_AUTHORITY_OWNER_APP,
        lease_sec: 5,
        reason: 'test',
      }),
      { timeoutMs: 8000 },
    );

    await requestControlAuthority(transport, 'renew');
    expect(callService).toHaveBeenLastCalledWith(
      CONTROL_AUTHORITY_SERVICE,
      CONTROL_AUTHORITY_SERVICE_TYPE,
      expect.objectContaining({ op: CONTROL_AUTHORITY_OPERATION.RENEW }),
      { timeoutMs: 1500 },
    );
  });

  it('parses ownership states', () => {
    expect(parseControlStatus({ data: 'available' })).toEqual({ state: 'available' });
    expect(parseControlStatus({ data: 'acquiring:app-123' })).toEqual({
      state: 'acquiring', ownerId: 'app-123',
    });
    expect(parseControlStatus({ data: 'acquired:app-123' })).toEqual({
      state: 'acquired', ownerId: 'app-123',
    });
    expect(parseControlStatus({ data: 'releasing:app-123' })).toEqual({
      state: 'releasing', ownerId: 'app-123',
    });
    expect(parseControlStatus({ data: 'cooldown:3' })).toEqual({
      state: 'cooldown', remainingSeconds: 3,
    });
    expect(parseControlStatus({ data: 'override_available:mission-42' })).toEqual({
      state: 'override_available', baseOwnerId: 'mission-42',
    });
    expect(parseControlStatus({ data: 'override_acquired:app-123:mission-42' })).toEqual({
      state: 'override_acquired', ownerId: 'app-123', baseOwnerId: 'mission-42',
    });
  });

  it('parses errors and rejects malformed states', () => {
    expect(parseControlStatus({ data: 'error:acquire:app-123:sdk_connect_timeout' })).toEqual({
      state: 'error', action: 'acquire', clientId: 'app-123', reason: 'sdk_connect_timeout',
    });
    expect(parseControlStatus({ data: 'acquired' })).toBeNull();
    expect(parseControlStatus({ data: 'cooldown:nope' })).toBeNull();
    expect(parseControlStatus({ data: 3 })).toBeNull();
  });

  it('expires a frozen authority snapshot and resets the deadline on heartbeat', () => {
    jest.useFakeTimers();
    const onStale = jest.fn();
    const watchdog = createControlAuthorityStatusWatchdog(onStale);

    watchdog.arm();
    jest.advanceTimersByTime(CONTROL_AUTHORITY_STATUS_STALE_MS - 1);
    expect(onStale).not.toHaveBeenCalled();

    watchdog.arm();
    jest.advanceTimersByTime(CONTROL_AUTHORITY_STATUS_STALE_MS - 1);
    expect(onStale).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onStale).toHaveBeenCalledTimes(1);

    watchdog.dispose();
    jest.useRealTimers();
  });
});
