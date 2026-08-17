import { CONTROL_CLIENT_ID } from './control-authority';
import type { Transport } from './transport';

export const SAFETY_SUPERVISOR_STATUS_TOPIC = '/omni/safety/supervisor_status';
export const CMD_VEL_ARBITER_STATUS_TOPIC = '/omni/cmd_vel/arbiter_status';
export const ARM_SUPERVISOR_SERVICE = '/omni/safety/arm_supervisor';
export const RESET_ESTOP_SERVICE = '/omni/safety/reset_estop';
export const SAFETY_STATUS_MESSAGE_TYPE = 'std_msgs/msg/String';
export const TRIGGER_SERVICE_TYPE = 'std_srvs/srv/Trigger';
export const SUPERVISOR_STATUS_STALE_MS = 3000;
export const ARBITER_STATUS_STALE_MS = 3000;

export interface SupervisorSafetyStatus {
  state: 'armed' | 'latched';
  outputEstop: boolean;
  reason: string;
  heartbeatFresh: boolean;
  heartbeatAgeMs: number | null;
  nextAction: string;
  consistent: boolean;
}

export interface ArbiterSafetyStatus {
  estop: boolean;
  estopMonitorFault: boolean;
  reason: string;
  selected: string;
  statusSeq: number;
}

function parseStatusFields(message: any): Record<string, string> | null {
  if (typeof message?.data !== 'string' || message.data.length === 0) return null;
  const fields: Record<string, string> = {};
  for (const entry of message.data.split(';')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    const key = entry.slice(0, separator).trim();
    if (!key) continue;
    fields[key] = entry.slice(separator + 1).trim();
  }
  return Object.keys(fields).length > 0 ? fields : null;
}

function parseBoolean(value: string | undefined): boolean | null {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

export function parseSupervisorSafetyStatus(message: any): SupervisorSafetyStatus | null {
  const fields = parseStatusFields(message);
  if (!fields || (fields.state !== 'armed' && fields.state !== 'latched')) return null;
  const outputEstop = parseBoolean(fields.output_estop);
  const heartbeatFresh = parseBoolean(fields.heartbeat_fresh);
  if (outputEstop === null || heartbeatFresh === null) return null;
  const parsedHeartbeatAge = Number.parseInt(fields.heartbeat_age_ms ?? '', 10);
  const state = fields.state;
  return {
    state,
    outputEstop,
    reason: fields.reason || 'unknown',
    heartbeatFresh,
    heartbeatAgeMs: Number.isFinite(parsedHeartbeatAge) ? parsedHeartbeatAge : null,
    nextAction: fields.next_action || 'unknown',
    consistent: (state === 'latched') === outputEstop,
  };
}

export function parseArbiterSafetyStatus(message: any): ArbiterSafetyStatus | null {
  const fields = parseStatusFields(message);
  if (!fields) return null;
  const estop = parseBoolean(fields.estop);
  const estopMonitorFault = parseBoolean(fields.estop_monitor_fault);
  const statusSeq = Number(fields.status_seq);
  if (
    estop === null ||
    estopMonitorFault === null ||
    !Number.isSafeInteger(statusSeq) ||
    statusSeq <= 0
  ) return null;
  return {
    estop,
    estopMonitorFault,
    reason: fields.reason || 'unknown',
    selected: fields.selected || 'none',
    statusSeq,
  };
}

export type SafetyDisplayLevel = 'unknown' | 'safe' | 'estop' | 'fault';

export interface SafetySummary {
  level: SafetyDisplayLevel;
  resetRequired: boolean;
  telemetryReady: boolean;
}

export function summarizeSafetyStatus(
  supervisor: SupervisorSafetyStatus | null,
  arbiter: ArbiterSafetyStatus | null,
  supervisorStale: boolean,
  arbiterStale: boolean,
): SafetySummary {
  if (!supervisor || !arbiter) {
    return { level: 'unknown', resetRequired: false, telemetryReady: false };
  }
  const resetRequired = supervisor.state === 'latched' || supervisor.outputEstop ||
    arbiter.estop;
  const telemetryReady = !supervisorStale && !arbiterStale &&
    supervisor.heartbeatFresh && supervisor.consistent && !arbiter.estopMonitorFault;
  if (!telemetryReady) {
    return { level: 'fault', resetRequired, telemetryReady };
  }
  if (resetRequired) return { level: 'estop', resetRequired, telemetryReady };
  return { level: 'safe', resetRequired, telemetryReady };
}

/**
 * Starting a reset is only valid when both independently latched E-stop paths
 * agree. In particular, an arbiter monitor fault is not repairable by the
 * arm/reset services and therefore must never enable the reset control.
 */
export function safetyResetMayStart(
  supervisor: SupervisorSafetyStatus | null,
  arbiter: ArbiterSafetyStatus | null,
  supervisorStale: boolean,
  arbiterStale: boolean,
): boolean {
  const summary = summarizeSafetyStatus(
    supervisor,
    arbiter,
    supervisorStale,
    arbiterStale,
  );
  return summary.telemetryReady && supervisor?.state === 'latched' &&
    supervisor.outputEstop && arbiter?.estop === true;
}

export interface SafetyResetAccess {
  connectionStatus: string;
  url: string;
  transport: Transport | null;
  authorityStatus: string;
  authorityOwnerId: string | null;
}

export interface SafetyResetSource {
  url: string;
  transport: Transport;
}

export function safetyResetIsAuthorized(
  access: SafetyResetAccess,
  expected?: SafetyResetSource,
): boolean {
  return access.connectionStatus === 'connected' && !!access.transport &&
    !access.url.startsWith('demo://') &&
    access.authorityStatus === 'acquired' && access.authorityOwnerId === CONTROL_CLIENT_ID &&
    (!expected || (access.url === expected.url && access.transport === expected.transport));
}

export type SafetyTriggerService =
  | typeof ARM_SUPERVISOR_SERVICE
  | typeof RESET_ESTOP_SERVICE;

export function callSafetyTrigger(
  transport: Transport,
  service: SafetyTriggerService,
): Promise<any> {
  return transport.callService(service, TRIGGER_SERVICE_TYPE, {});
}

export type SafetyResetStage = 'arm_supervisor' | 'reset_estop';
export type SafetyResetOutcome =
  | { kind: 'completed'; message: string }
  | { kind: 'cancelled'; stage: SafetyResetStage }
  | { kind: 'blocked'; stage: SafetyResetStage }
  | { kind: 'failed'; stage: SafetyResetStage; message: string };

interface SafetyResetSequenceOptions {
  isAuthorized: () => boolean;
  confirmArmSupervisor: () => Promise<boolean>;
  confirmResetEstop: (armMessage: string) => Promise<boolean>;
  callTrigger: (service: SafetyTriggerService) => Promise<any>;
}

function responseMessage(response: any, fallback: string): string {
  return typeof response?.message === 'string' && response.message.length > 0
    ? response.message
    : fallback;
}

/**
 * Deliberately requires two separate user confirmations. A failed/cancelled
 * supervisor arm can never fall through to the independently latched Bridge.
 */
export async function runTwoStageSafetyReset(
  options: SafetyResetSequenceOptions,
): Promise<SafetyResetOutcome> {
  if (!options.isAuthorized()) return { kind: 'blocked', stage: 'arm_supervisor' };

  let armConfirmed: boolean;
  try {
    armConfirmed = await options.confirmArmSupervisor();
  } catch (error: any) {
    return { kind: 'failed', stage: 'arm_supervisor', message: error?.message || String(error) };
  }
  if (!armConfirmed) return { kind: 'cancelled', stage: 'arm_supervisor' };
  if (!options.isAuthorized()) return { kind: 'blocked', stage: 'arm_supervisor' };

  let armResponse: any;
  try {
    armResponse = await options.callTrigger(ARM_SUPERVISOR_SERVICE);
  } catch (error: any) {
    return { kind: 'failed', stage: 'arm_supervisor', message: error?.message || String(error) };
  }
  if (armResponse?.success !== true) {
    return {
      kind: 'failed',
      stage: 'arm_supervisor',
      message: responseMessage(armResponse, 'arm_supervisor_failed'),
    };
  }
  if (!options.isAuthorized()) return { kind: 'blocked', stage: 'reset_estop' };

  let resetConfirmed: boolean;
  try {
    resetConfirmed = await options.confirmResetEstop(
      responseMessage(armResponse, 'supervisor_armed'),
    );
  } catch (error: any) {
    return { kind: 'failed', stage: 'reset_estop', message: error?.message || String(error) };
  }
  if (!resetConfirmed) return { kind: 'cancelled', stage: 'reset_estop' };
  if (!options.isAuthorized()) return { kind: 'blocked', stage: 'reset_estop' };

  let resetResponse: any;
  try {
    resetResponse = await options.callTrigger(RESET_ESTOP_SERVICE);
  } catch (error: any) {
    return { kind: 'failed', stage: 'reset_estop', message: error?.message || String(error) };
  }
  if (resetResponse?.success !== true) {
    return {
      kind: 'failed',
      stage: 'reset_estop',
      message: responseMessage(resetResponse, 'reset_estop_failed'),
    };
  }
  return { kind: 'completed', message: responseMessage(resetResponse, 'estop_reset') };
}
