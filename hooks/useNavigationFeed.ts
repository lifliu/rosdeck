import { useEffect } from 'react';
import { subscribeNavigationStatus } from '../lib/navigation';
import { useNavigationStore } from '../stores/useNavigationStore';
import { useRosStore } from '../stores/useRosStore';

export const NAVIGATION_STATUS_STALE_MS = 3500;

/** 单例订阅 Mission 的导航状态，页面重连后只恢复机器人权威快照。 */
export function useNavigationFeed(enabled = true): void {
  const connectionStatus = useRosStore((state) => state.connection.status);
  const transport = useRosStore((state) => state.transport);
  const url = useRosStore((state) => state.connection.url);

  useEffect(() => {
    if (!enabled || connectionStatus !== 'connected' || !transport || url.startsWith('demo://')) {
      useNavigationStore.getState().resetFeed();
      return;
    }

    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    const subscription = subscribeNavigationStatus(transport, (status) => {
      useNavigationStore.getState().onStatus(status);
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => useNavigationStore.getState().markStale(), NAVIGATION_STATUS_STALE_MS);
    });

    return () => {
      subscription.unsubscribe();
      if (staleTimer) clearTimeout(staleTimer);
      useNavigationStore.getState().markStale();
    };
  }, [connectionStatus, enabled, transport, url]);
}
