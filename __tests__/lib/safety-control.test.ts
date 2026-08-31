import { CONTROL_CLIENT_ID } from '../../lib/control-authority';
import {
  ARM_SUPERVISOR_SERVICE,
  CMD_VEL_ARBITER_STATUS_TOPIC,
  RESET_ESTOP_SERVICE,
  SAFETY_STATUS_MESSAGE_TYPE,
  SAFETY_SUPERVISOR_STATUS_TOPIC,
  TRIGGER_SERVICE_TYPE,
  callSafetyTrigger,
  parseArbiterSafetyStatus,
  parseSupervisorSafetyStatus,
  runTwoStageSafetyReset,
  safetyResetIsAuthorized,
  safetyResetMayStart,
  summarizeSafetyStatus,
} from '../../lib/safety-control';
import type { Transport } from '../../lib/transport';

function makeTransport(): Transport {
  return {
    connect: jest.fn(),
    disconnect: jest.fn(),
    subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })),
    publish: jest.fn(),
    callService: jest.fn(),
    getTopics: jest.fn().mockResolvedValue([]),
    onStatus: jest.fn(() => jest.fn()),
    getStatus: jest.fn(() => 'connected'),
  } as Transport;
}

describe('safety status protocol', () => {
  it('uses the canonical String topics and Trigger services', () => {
    expect(SAFETY_SUPERVISOR_STATUS_TOPIC).toBe('/omni/safety/supervisor_status');
    expect(CMD_VEL_ARBITER_STATUS_TOPIC).toBe('/omni/cmd_vel/arbiter_status');
    expect(SAFETY_STATUS_MESSAGE_TYPE).toBe('std_msgs/msg/String');
    expect(ARM_SUPERVISOR_SERVICE).toBe('/omni/safety/arm_supervisor');
    expect(RESET_ESTOP_SERVICE).toBe('/omni/safety/reset_estop');
    expect(TRIGGER_SERVICE_TYPE).toBe('std_srvs/srv/Trigger');
  });

  it('parses the supervisor heartbeat and fail-closed latch fields', () => {
    expect(parseSupervisorSafetyStatus({
      data: 'state=latched;output_estop=true;reason=startup;heartbeat_fresh=true;' +
        'heartbeat_age_ms=12;next_action=arm_supervisor',
    })).toEqual({
      state: 'latched',
      outputEstop: true,
      reason: 'startup',
      heartbeatFresh: true,
      heartbeatAgeMs: 12,
      nextAction: 'arm_supervisor',
      consistent: true,
    });
    expect(parseSupervisorSafetyStatus({ data: 'state=armed;output_estop=maybe' })).toBeNull();
    expect(parseSupervisorSafetyStatus({ data: 7 })).toBeNull();
  });

  it('parses the independently latched arbiter E-stop fields', () => {
    expect(parseArbiterSafetyStatus({
      data: 'selected=none;reason=estop_latched;estop=true;' +
        'estop_monitor_fault=false;status_seq=17',
    })).toEqual({
      estop: true,
      estopMonitorFault: false,
      reason: 'estop_latched',
      selected: 'none',
      statusSeq: 17,
    });
    expect(parseArbiterSafetyStatus({ data: 'estop=false' })).toBeNull();
  });

  it('rejects missing, non-finite, non-integer, and non-positive arbiter sequences', () => {
    const prefix = 'selected=none;estop=true;estop_monitor_fault=false;status_seq=';
    expect(parseArbiterSafetyStatus({
      data: 'selected=none;estop=true;estop_monitor_fault=false',
    })).toBeNull();
    for (const statusSeq of ['NaN', 'Infinity', '1.5', '0', '-1', '9007199254740992']) {
      expect(parseArbiterSafetyStatus({ data: prefix + statusSeq })).toBeNull();
    }
    expect(parseArbiterSafetyStatus({ data: prefix + '1' })?.statusSeq).toBe(1);
  });

  it('reports safe, latched, stale, and inconsistent telemetry fail-closed', () => {
    const armed = parseSupervisorSafetyStatus({
      data: 'state=armed;output_estop=false;reason=armed;heartbeat_fresh=true',
    })!;
    const ready = parseArbiterSafetyStatus({
      data: 'selected=none;reason=no_fresh_input;estop=false;' +
        'estop_monitor_fault=false;status_seq=1',
    })!;
    expect(summarizeSafetyStatus(armed, ready, false, false)).toEqual({
      level: 'safe', resetRequired: false, telemetryReady: true,
    });
    expect(summarizeSafetyStatus(armed, ready, true, false)).toEqual({
      level: 'fault', resetRequired: false, telemetryReady: false,
    });
    expect(summarizeSafetyStatus(armed, ready, false, true)).toEqual({
      level: 'fault', resetRequired: false, telemetryReady: false,
    });

    const latched = parseSupervisorSafetyStatus({
      data: 'state=latched;output_estop=true;reason=estop_request;heartbeat_fresh=true',
    })!;
    const latchedArbiter = parseArbiterSafetyStatus({
      data: 'selected=none;reason=estop_latched;estop=true;' +
        'estop_monitor_fault=false;status_seq=2',
    })!;
    expect(summarizeSafetyStatus(latched, latchedArbiter, false, false)).toEqual({
      level: 'estop', resetRequired: true, telemetryReady: true,
    });
    expect(safetyResetMayStart(latched, latchedArbiter, false, false)).toBe(true);
    expect(safetyResetMayStart(latched, latchedArbiter, false, true)).toBe(false);
    expect(safetyResetMayStart(armed, latchedArbiter, false, false)).toBe(false);

    const inconsistent = parseSupervisorSafetyStatus({
      data: 'state=armed;output_estop=true;reason=unknown;heartbeat_fresh=true',
    })!;
    expect(summarizeSafetyStatus(inconsistent, ready, false, false)).toEqual({
      level: 'fault', resetRequired: true, telemetryReady: false,
    });

    const monitorFault = parseArbiterSafetyStatus({
      data: 'selected=none;reason=no_fresh_input;estop=false;' +
        'estop_monitor_fault=true;status_seq=3',
    })!;
    expect(summarizeSafetyStatus(armed, monitorFault, false, false)).toEqual({
      level: 'fault', resetRequired: false, telemetryReady: false,
    });
    expect(safetyResetMayStart(latched, monitorFault, false, false)).toBe(false);
  });
});

describe('safety reset authorization', () => {
  const transport = makeTransport();
  const allowed = {
    connectionStatus: 'connected',
    url: 'ws://robot-a:9090',
    transport,
    authorityStatus: 'acquired',
    authorityOwnerId: CONTROL_CLIENT_ID,
  };

  it('requires a real connected robot owned by this App', () => {
    expect(safetyResetIsAuthorized(allowed)).toBe(true);
    expect(safetyResetIsAuthorized({ ...allowed, connectionStatus: 'disconnected' })).toBe(false);
    expect(safetyResetIsAuthorized({ ...allowed, url: 'demo://local' })).toBe(false);
    expect(safetyResetIsAuthorized({ ...allowed, transport: null })).toBe(false);
    expect(safetyResetIsAuthorized({ ...allowed, authorityStatus: 'unsupported' })).toBe(false);
    expect(safetyResetIsAuthorized({ ...allowed, authorityOwnerId: 'another-app' })).toBe(false);
  });

  it('allows cold-start recovery only after this App acquires the authorization lease', () => {
    const supervisor = parseSupervisorSafetyStatus({
      data: 'state=latched;output_estop=true;reason=startup;heartbeat_fresh=true',
    })!;
    const arbiter = parseArbiterSafetyStatus({
      data: 'selected=none;reason=estop_latched;estop=true;' +
        'estop_monitor_fault=false;status_seq=1',
    })!;
    expect(safetyResetMayStart(supervisor, arbiter, false, false)).toBe(true);
    expect(safetyResetIsAuthorized({
      ...allowed,
      authorityStatus: 'acquiring',
      authorityOwnerId: CONTROL_CLIENT_ID,
    })).toBe(false);
    expect(safetyResetIsAuthorized(allowed)).toBe(true);
  });

  it('rejects a replaced transport even when the robot URL is unchanged', () => {
    expect(safetyResetIsAuthorized(allowed, {
      url: allowed.url,
      transport: makeTransport(),
    })).toBe(false);
  });

  it('calls Trigger with an empty request through the current transport', async () => {
    (transport.callService as jest.Mock).mockResolvedValueOnce({ success: true });
    await callSafetyTrigger(transport, ARM_SUPERVISOR_SERVICE);
    expect(transport.callService).toHaveBeenLastCalledWith(
      ARM_SUPERVISOR_SERVICE,
      TRIGGER_SERVICE_TYPE,
      {},
    );
  });
});

describe('two-stage safety reset orchestration', () => {
  it('requires two confirmations and calls arm before Bridge reset', async () => {
    const events: string[] = [];
    const outcome = await runTwoStageSafetyReset({
      isAuthorized: () => true,
      confirmArmSupervisor: async () => { events.push('confirm-arm'); return true; },
      confirmResetEstop: async (message) => {
        events.push(`confirm-reset:${message}`);
        return true;
      },
      callTrigger: async (service) => {
        events.push(`call:${service}`);
        return service === ARM_SUPERVISOR_SERVICE
          ? { success: true, message: 'supervisor_armed' }
          : { success: true, message: 'estop_reset' };
      },
    });

    expect(events).toEqual([
      'confirm-arm',
      `call:${ARM_SUPERVISOR_SERVICE}`,
      'confirm-reset:supervisor_armed',
      `call:${RESET_ESTOP_SERVICE}`,
    ]);
    expect(outcome).toEqual({ kind: 'completed', message: 'estop_reset' });
  });

  it('never continues when supervisor arm fails', async () => {
    const confirmResetEstop = jest.fn().mockResolvedValue(true);
    const callTrigger = jest.fn().mockResolvedValue({
      success: false,
      message: 'supervisor_heartbeat_stale',
    });
    await expect(runTwoStageSafetyReset({
      isAuthorized: () => true,
      confirmArmSupervisor: async () => true,
      confirmResetEstop,
      callTrigger,
    })).resolves.toEqual({
      kind: 'failed',
      stage: 'arm_supervisor',
      message: 'supervisor_heartbeat_stale',
    });
    expect(callTrigger).toHaveBeenCalledTimes(1);
    expect(callTrigger).toHaveBeenCalledWith(ARM_SUPERVISOR_SERVICE);
    expect(confirmResetEstop).not.toHaveBeenCalled();
  });

  it('leaves the Bridge latched when the second confirmation is cancelled', async () => {
    const callTrigger = jest.fn().mockResolvedValue({
      success: true,
      message: 'supervisor_armed',
    });
    await expect(runTwoStageSafetyReset({
      isAuthorized: () => true,
      confirmArmSupervisor: async () => true,
      confirmResetEstop: async () => false,
      callTrigger,
    })).resolves.toEqual({ kind: 'cancelled', stage: 'reset_estop' });
    expect(callTrigger).toHaveBeenCalledTimes(1);
    expect(callTrigger).not.toHaveBeenCalledWith(RESET_ESTOP_SERVICE);
  });

  it('stops after arm when ownership or connection changes', async () => {
    let authorized = true;
    const confirmResetEstop = jest.fn().mockResolvedValue(true);
    const callTrigger = jest.fn().mockImplementation(async () => {
      authorized = false;
      return { success: true, message: 'supervisor_armed' };
    });
    await expect(runTwoStageSafetyReset({
      isAuthorized: () => authorized,
      confirmArmSupervisor: async () => true,
      confirmResetEstop,
      callTrigger,
    })).resolves.toEqual({ kind: 'blocked', stage: 'reset_estop' });
    expect(callTrigger).toHaveBeenCalledTimes(1);
    expect(confirmResetEstop).not.toHaveBeenCalled();
  });

  it('stops after arm when the live arbiter heartbeat becomes stale', async () => {
    const supervisor = parseSupervisorSafetyStatus({
      data: 'state=latched;output_estop=true;reason=estop_request;heartbeat_fresh=true',
    })!;
    const arbiter = parseArbiterSafetyStatus({
      data: 'selected=none;reason=estop_latched;estop=true;' +
        'estop_monitor_fault=false;status_seq=9',
    })!;
    let armAccepted = false;
    let arbiterStale = false;
    const confirmResetEstop = jest.fn().mockResolvedValue(true);
    const callTrigger = jest.fn().mockImplementation(async () => {
      armAccepted = true;
      arbiterStale = true;
      return { success: true, message: 'supervisor_armed' };
    });
    const isAuthorized = () => {
      const summary = summarizeSafetyStatus(supervisor, arbiter, false, arbiterStale);
      return armAccepted
        ? summary.telemetryReady && arbiter.estop
        : safetyResetMayStart(supervisor, arbiter, false, arbiterStale);
    };

    await expect(runTwoStageSafetyReset({
      isAuthorized,
      confirmArmSupervisor: async () => true,
      confirmResetEstop,
      callTrigger,
    })).resolves.toEqual({ kind: 'blocked', stage: 'reset_estop' });
    expect(callTrigger).toHaveBeenCalledTimes(1);
    expect(confirmResetEstop).not.toHaveBeenCalled();
  });

  it('does not even prompt or call a service when access is blocked', async () => {
    const confirmArmSupervisor = jest.fn().mockResolvedValue(true);
    const callTrigger = jest.fn();
    await expect(runTwoStageSafetyReset({
      isAuthorized: () => false,
      confirmArmSupervisor,
      confirmResetEstop: jest.fn(),
      callTrigger,
    })).resolves.toEqual({ kind: 'blocked', stage: 'arm_supervisor' });
    expect(confirmArmSupervisor).not.toHaveBeenCalled();
    expect(callTrigger).not.toHaveBeenCalled();
  });
});
