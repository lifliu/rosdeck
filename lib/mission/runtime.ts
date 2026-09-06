import type { Transport } from '../transport';

export const INSPECTION_RUNTIME_COMMAND_TOPIC = '/rosdeck/start_inspection_runtime';
export const INSPECTION_RUNTIME_STATUS_TOPIC = '/rosdeck/inspection_runtime_status';
export const INSPECTION_RUNTIME_COMMAND_TYPE = 'std_msgs/msg/Bool';
export const INSPECTION_RUNTIME_STATUS_TYPE = 'std_msgs/msg/String';

export type InspectionRuntimeState =
  | 'unknown'
  | 'disabled'
  | 'idle'
  | 'switchable_navigation'
  | 'starting'
  | 'running_managed'
  | 'running_external'
  | 'partial'
  | 'stopping'
  | 'error';

export function extractInspectionRuntimeStatus(message: any): string {
  return typeof message?.data === 'string' ? message.data : '';
}

/** 将 Bridge 的巡检运行时线协议转换成稳定的 APP 状态。 */
export function parseInspectionRuntimeState(status: string): InspectionRuntimeState {
  if (status === 'disabled') return 'disabled';
  if (status === 'idle' || status.startsWith('stopped:')) return 'idle';
  if (status === 'switchable:single_point_navigation') return 'switchable_navigation';
  if (status.startsWith('starting:') || status.startsWith('switching:')) return 'starting';
  if (status === 'running:managed') return 'running_managed';
  if (status === 'running:external') return 'running_external';
  if (status.startsWith('partial:')) return 'partial';
  if (
    status.startsWith('stopping:') ||
    status.startsWith('terminating:') ||
    status.startsWith('killing:')
  ) return 'stopping';
  if (status.startsWith('error:') || status.startsWith('exited:')) return 'error';
  return 'unknown';
}

/**
 * APP 只发送布尔意图；脚本、地图和数据目录均由机器人端固定配置，避免把
 * 移动端输入扩展成远程命令执行面。
 */
export function commandInspectionRuntime(transport: Transport, start: boolean): void {
  transport.publish(
    INSPECTION_RUNTIME_COMMAND_TOPIC,
    INSPECTION_RUNTIME_COMMAND_TYPE,
    { data: start },
  );
}
