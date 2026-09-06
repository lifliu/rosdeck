import { useEffect } from 'react';
import {
  AUTONOMY_MODE,
  AUTONOMY_PHASE,
  subscribeAutonomyRuntimeStatus,
  type AutonomyRuntimeStatus,
} from '../lib/autonomy-runtime';
import { useAutonomyRuntimeStore } from '../stores/useAutonomyRuntimeStore';
import { useLayoutStore } from '../stores/useLayoutStore';
import { useMappingStore } from '../stores/useMappingStore';
import { useRosStore } from '../stores/useRosStore';

export const AUTONOMY_RUNTIME_STALE_MS = 3500;

/**
 * 把 Mission Manager 的权威建图模式投影为点云预览会话。
 *
 * 该同步属于状态订阅生命周期，不能放在“机器人动作”弹窗里的建图按钮中；
 * 否则 APP 重启或重连到一个已经开始的建图会话时，按钮尚未挂载，点云会被
 * 错误标成静态预览。重复状态心跳不会重复增加 sessionId。
 */
export function synchronizeMappingPreview(
  status: AutonomyRuntimeStatus | null,
): void {
  const mappingStore = useMappingStore.getState();
  const active = status?.mode === AUTONOMY_MODE.MAPPING &&
    status.phase !== AUTONOMY_PHASE.STOPPING;
  if (active) {
    if (!mappingStore.active) {
      mappingStore.startSession();
      const layoutStore = useLayoutStore.getState();
      if (layoutStore.layouts.some((layout) => layout.id === 'mapping-3d')) {
        layoutStore.setActiveLayout('mapping-3d');
      }
    }
    return;
  }
  if (mappingStore.active) mappingStore.stopSession();
}

/**
 * 在控制台生命周期内只建立一条运行时状态订阅，并把快照写入共享 Store。
 * 具体按钮不再分别订阅 Bridge 私有话题，因此它们看到的是同一代运行时状态。
 */
export function useAutonomyRuntimeFeed(enabled = true): void {
  const connectionStatus = useRosStore((state) => state.connection.status);
  const transport = useRosStore((state) => state.transport);
  const url = useRosStore((state) => state.connection.url);

  useEffect(() => {
    if (!enabled || connectionStatus !== 'connected' || !transport || url.startsWith('demo://')) {
      useAutonomyRuntimeStore.getState().resetFeed();
      synchronizeMappingPreview(null);
      return;
    }

    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    const armStaleTimer = () => {
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        useAutonomyRuntimeStore.getState().markStale();
        synchronizeMappingPreview(null);
      }, AUTONOMY_RUNTIME_STALE_MS);
    };

    const subscription = subscribeAutonomyRuntimeStatus(transport, (runtimeStatus) => {
      useAutonomyRuntimeStore.getState().onStatus(runtimeStatus);
      synchronizeMappingPreview(runtimeStatus);
      armStaleTimer();
    });

    return () => {
      subscription.unsubscribe();
      if (staleTimer) clearTimeout(staleTimer);
      // 页面离开或连接对象更换后，旧快照只能用于展示，不能继续使能操作按钮。
      useAutonomyRuntimeStore.getState().markStale();
      synchronizeMappingPreview(null);
    };
  }, [connectionStatus, enabled, transport, url]);
}
