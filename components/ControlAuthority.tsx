import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { theme } from '../constants/theme';
import {
  CONTROL_CLIENT_ID,
  CONTROL_AUTHORITY_STATUS_TOPIC,
  CONTROL_AUTHORITY_STATUS_TYPE,
  createControlAuthorityStatusWatchdog,
  parseTypedControlStatus,
  requestControlAuthority,
} from '../lib/control-authority';
import { useTranslation } from '../lib/i18n';
import { useControlAuthorityStore } from '../stores/useControlAuthorityStore';
import { useRosStore } from '../stores/useRosStore';
import { useCmdVelStore } from '../stores/useCmdVelStore';

const DETECTION_TIMEOUT_MS = 4000;
const HEARTBEAT_PERIOD_MS = 1000;

/** 挂载在应用根层，使控制权订阅与续租不受 Tab 切换影响。 */
export function ControlAuthoritySession() {
  const connectionStatus = useRosStore((state) => state.connection.status);
  const transport = useRosStore((state) => state.transport);
  const url = useRosStore((state) => state.connection.url);
  const authorityStatus = useControlAuthorityStore((state) => state.status);
  const ownerId = useControlAuthorityStore((state) => state.ownerId);
  const previouslyAcquiredRef = useRef(false);

  useEffect(() => {
    if (connectionStatus !== 'connected' || !transport || url.startsWith('demo://')) {
      useControlAuthorityStore.getState().reset(
        url.startsWith('demo://') ? 'unsupported' : 'disconnected',
      );
      return;
    }

    useControlAuthorityStore.getState().reset('detecting');
    let active = true;
    const watchdog = createControlAuthorityStatusWatchdog(() => {
      // WebSocket 在线不代表 Bridge provider 仍存活。权威心跳过期后立即清除
      // 本地 owner，阻止摇杆和姿态控制沿用旧租约快照。
      useControlAuthorityStore.getState().reset('stale');
    });
    const subscription = transport.subscribe(
      CONTROL_AUTHORITY_STATUS_TOPIC,
      CONTROL_AUTHORITY_STATUS_TYPE,
      (message) => {
        if (!active) return;
        const parsed = parseTypedControlStatus(message);
        if (!parsed) return;
        useControlAuthorityStore.getState().applyStatus(parsed);
        watchdog.arm();
      },
    );
    const detectionTimeout = setTimeout(() => {
      if (useControlAuthorityStore.getState().status === 'detecting') {
        // 旧 Bridge/VBot 不发布 typed authority；统一 teleop 对此状态保持失败关闭。
        useControlAuthorityStore.getState().reset('unsupported');
      }
    }, DETECTION_TIMEOUT_MS);

    return () => {
      active = false;
      clearTimeout(detectionTimeout);
      watchdog.dispose();
      subscription.unsubscribe();
    };
  }, [connectionStatus, transport, url]);

  useEffect(() => {
    const controllableByThisApp =
      (authorityStatus === 'acquired' || authorityStatus === 'override_acquired') &&
      ownerId === CONTROL_CLIENT_ID;
    if (previouslyAcquiredRef.current && !controllableByThisApp) {
      useCmdVelStore.getState().clearAll();
    }
    previouslyAcquiredRef.current = controllableByThisApp;
  }, [authorityStatus, ownerId]);

  useEffect(() => {
    if (connectionStatus !== 'connected' || !transport ||
      (authorityStatus !== 'acquired' && authorityStatus !== 'override_acquired') ||
      ownerId !== CONTROL_CLIENT_ID) return;

    let renewInFlight = false;
    let active = true;
    const renew = async () => {
      if (!active || renewInFlight || useRosStore.getState().transport !== transport) return;
      // The connection effect above resets the store before this render's
      // captured selectors catch up. Never renew the previous robot's lease.
      const current = useControlAuthorityStore.getState();
      if ((current.status !== 'acquired' && current.status !== 'override_acquired') ||
        current.ownerId !== CONTROL_CLIENT_ID) return;
      renewInFlight = true;
      try {
        const response = await requestControlAuthority(transport, 'renew', 'app_lease_heartbeat');
        if (active && !response.accepted) {
          useControlAuthorityStore.getState().applyStatus({
            state: 'error',
            action: 'renew',
            clientId: CONTROL_CLIENT_ID,
            reason: response.reasonText || `reason_${response.reasonCode}`,
          });
        }
      } catch {
        // 连接状态或 Bridge 租约超时会把控制权收回；单次心跳异常不弹窗刷屏。
      } finally {
        renewInFlight = false;
      }
    };
    void renew();
    const heartbeat = setInterval(() => {
      void renew();
    }, HEARTBEAT_PERIOD_MS);
    return () => { active = false; clearInterval(heartbeat); };
  }, [authorityStatus, connectionStatus, ownerId, transport]);

  return null;
}

export function ControlAuthorityButton({ compact = false }: { compact?: boolean }) {
  const connectionStatus = useRosStore((state) => state.connection.status);
  const transport = useRosStore((state) => state.transport);
  const url = useRosStore((state) => state.connection.url);
  const status = useControlAuthorityStore((state) => state.status);
  const ownerId = useControlAuthorityStore((state) => state.ownerId);
  const cooldownSeconds = useControlAuthorityStore((state) => state.cooldownSeconds);
  const error = useControlAuthorityStore((state) => state.error);
  const lastErrorRef = useRef<string | null>(null);
  const { t } = useTranslation();

  useEffect(() => {
    if (status !== 'error') {
      lastErrorRef.current = null;
      return;
    }
    if (!error || lastErrorRef.current === error) return;
    lastErrorRef.current = error;
    Alert.alert(t('authority.failedTitle'), t('authority.error', { message: error }));
  }, [error, status, t]);

  const acquire = useCallback(async () => {
    if (!transport || connectionStatus !== 'connected') return;
    useControlAuthorityStore.getState().beginAcquire();
    try {
      const response = await requestControlAuthority(transport, 'acquire', 'app_user_acquire');
      if (useRosStore.getState().transport !== transport || transport.getStatus() !== 'connected') return;
      if (!response.accepted) {
        useControlAuthorityStore.getState().applyStatus({
          state: 'error',
          action: 'acquire',
          clientId: CONTROL_CLIENT_ID,
          reason: response.reasonText || `reason_${response.reasonCode}`,
        });
      }
    } catch (requestError: any) {
      if (useRosStore.getState().transport !== transport || transport.getStatus() !== 'connected') return;
      useControlAuthorityStore.getState().applyStatus({
        state: 'error',
        action: 'acquire',
        clientId: CONTROL_CLIENT_ID,
        reason: requestError?.message ?? String(requestError),
      });
    }
  }, [connectionStatus, transport]);

  const release = useCallback(async () => {
    if (!transport || connectionStatus !== 'connected') return;
    useControlAuthorityStore.getState().beginRelease();
    try {
      const response = await requestControlAuthority(transport, 'release', 'app_user_release');
      if (useRosStore.getState().transport !== transport || transport.getStatus() !== 'connected') return;
      if (!response.accepted) {
        useControlAuthorityStore.getState().applyStatus({
          state: 'error',
          action: 'release',
          clientId: CONTROL_CLIENT_ID,
          reason: response.reasonText || `reason_${response.reasonCode}`,
        });
      }
    } catch (requestError: any) {
      if (useRosStore.getState().transport !== transport || transport.getStatus() !== 'connected') return;
      useControlAuthorityStore.getState().applyStatus({
        state: 'error',
        action: 'release',
        clientId: CONTROL_CLIENT_ID,
        reason: requestError?.message ?? String(requestError),
      });
    }
  }, [connectionStatus, transport]);

  const confirm = useCallback(() => {
    const acquiredByThisApp = status === 'acquired' && ownerId === CONTROL_CLIENT_ID;
    const overrideByThisApp = status === 'override_acquired' && ownerId === CONTROL_CLIENT_ID;
    if (acquiredByThisApp || overrideByThisApp) {
      Alert.alert(
        t(overrideByThisApp ? 'authority.overrideReleaseTitle' : 'authority.releaseTitle'),
        t(overrideByThisApp ? 'authority.overrideReleaseMessage' : 'authority.releaseMessage'), [
        { text: t('authority.cancel'), style: 'cancel' },
        {
          text: t(overrideByThisApp ?
            'authority.overrideReleaseButton' : 'authority.releaseButton'),
          style: overrideByThisApp ? 'default' : 'destructive',
          onPress: release,
        },
      ]);
    } else {
      const overrideAvailable = status === 'override_available';
      Alert.alert(
        t(overrideAvailable ? 'authority.overrideAcquireTitle' : 'authority.acquireTitle'),
        t(overrideAvailable ? 'authority.overrideAcquireMessage' : 'authority.acquireMessage'), [
        { text: t('authority.cancel'), style: 'cancel' },
        {
          text: t(overrideAvailable ?
            'authority.overrideAcquireButton' : 'authority.acquireButton'),
          onPress: acquire,
        },
      ]);
    }
  }, [acquire, ownerId, release, status, t]);

  if (status === 'unsupported' || status === 'disconnected' || url.startsWith('demo://')) {
    return null;
  }

  const acquiredByThisApp = status === 'acquired' && ownerId === CONTROL_CLIENT_ID;
  const overrideByThisApp = status === 'override_acquired' && ownerId === CONTROL_CLIENT_ID;
  const disabled = connectionStatus !== 'connected' || status === 'detecting' ||
    status === 'stale' ||
    status === 'acquiring' || status === 'releasing' || status === 'cooldown' ||
    status === 'owned_by_other';
  const label = status === 'detecting' ? t('authority.detecting')
    : status === 'stale' ? t('authority.stale')
      : status === 'acquiring' ? t('authority.acquiring')
      : status === 'releasing' ? t('authority.releasing')
        : status === 'cooldown' ? t('authority.cooldown', { seconds: cooldownSeconds })
          : status === 'owned_by_other' ? t('authority.ownedByOther')
            : overrideByThisApp ? t('authority.overrideReleaseButton')
              : status === 'override_available' ? t('authority.overrideAcquireButton')
                : acquiredByThisApp ? t('authority.releaseButton')
              : status === 'error' ? t('authority.retryButton')
                : t('authority.acquireButton');
  const color = acquiredByThisApp ? theme.colors.statusError
    : overrideByThisApp ? theme.colors.statusConnecting
    : disabled ? theme.colors.textMuted : theme.colors.statusConnecting;

  return (
    <View style={styles.container}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={label}
        disabled={disabled}
        onPress={confirm}
        activeOpacity={0.75}
        style={[
          styles.button,
          compact && styles.compactButton,
          { borderColor: color + '66', backgroundColor: color + '11' },
          disabled && styles.disabled,
        ]}
      >
        <Ionicons
          name={disabled ? 'hourglass-outline' : acquiredByThisApp ?
            'lock-open-outline' : overrideByThisApp ? 'hand-left-outline' : 'key-outline'}
          size={compact ? 20 : 16}
          color={color}
        />
        {!compact && <Text style={[styles.text, { color }]}>{label}</Text>}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexDirection: 'row' },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: theme.radius.md,
    borderWidth: 1,
  },
  compactButton: {
    width: 40,
    height: 40,
    minHeight: 40,
    paddingHorizontal: 0,
  },
  disabled: { opacity: 0.55 },
  text: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    fontWeight: '600',
  },
});
