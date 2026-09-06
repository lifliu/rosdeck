import { useEffect } from 'react';
import { subscribeAutonomyRuntimeStatus } from '../lib/autonomy-runtime';
import { useAutonomyRuntimeStore } from '../stores/useAutonomyRuntimeStore';
import { useRosStore } from '../stores/useRosStore';

export const AUTONOMY_RUNTIME_STALE_MS = 3500;

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
      return;
    }

    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    const armStaleTimer = () => {
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        useAutonomyRuntimeStore.getState().markStale();
      }, AUTONOMY_RUNTIME_STALE_MS);
    };

    const subscription = subscribeAutonomyRuntimeStatus(transport, (runtimeStatus) => {
      useAutonomyRuntimeStore.getState().onStatus(runtimeStatus);
      armStaleTimer();
    });

    return () => {
      subscription.unsubscribe();
      if (staleTimer) clearTimeout(staleTimer);
      // 页面离开或连接对象更换后，旧快照只能用于展示，不能继续使能操作按钮。
      useAutonomyRuntimeStore.getState().markStale();
    };
  }, [connectionStatus, enabled, transport, url]);
}
