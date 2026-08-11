import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { theme } from '../constants/theme';
import {
  CONTROL_CLIENT_ID,
  CONTROL_MESSAGE_TYPE,
  CONTROL_STATUS_TOPIC,
  parseControlStatus,
  publishControlAction,
} from '../lib/control-authority';
import { useTranslation } from '../lib/i18n';
import { useControlAuthorityStore } from '../stores/useControlAuthorityStore';
import { useRosStore } from '../stores/useRosStore';
import { useCmdVelStore } from '../stores/useCmdVelStore';

const DETECTION_TIMEOUT_MS = 4000;
const DETECTION_RETRY_MS = 500;
const HEARTBEAT_PERIOD_MS = 1000;

/** Mounted at the app root so the lease survives tab changes. */
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
    const subscription = transport.subscribe(
      CONTROL_STATUS_TOPIC,
      CONTROL_MESSAGE_TYPE,
      (message) => {
        const parsed = parseControlStatus(message);
        if (!parsed) return;
        if (parsed.state === 'error' && parsed.clientId !== CONTROL_CLIENT_ID) return;
        useControlAuthorityStore.getState().applyStatus(parsed);
        if (parsed.state === 'error') {
          setTimeout(() => {
            if (transport.getStatus() === 'connected') {
              publishControlAction(transport, 'status');
            }
          }, 1500);
        }
      },
    );
    const requestStatus = () => {
      try {
        publishControlAction(transport, 'status');
      } catch {
        // The connection-status handler will reset detection if the socket
        // closes while a retry is being sent.
      }
    };
    const detectionRetry = setInterval(() => {
      if (useControlAuthorityStore.getState().status === 'detecting') {
        requestStatus();
      } else {
        clearInterval(detectionRetry);
      }
    }, DETECTION_RETRY_MS);
    const detectionTimeout = setTimeout(() => {
      if (useControlAuthorityStore.getState().status === 'detecting') {
        // Legacy/VBot bridges do not expose the ownership protocol.
        useControlAuthorityStore.getState().reset('unsupported');
      }
    }, DETECTION_TIMEOUT_MS);

    requestStatus();
    return () => {
      clearInterval(detectionRetry);
      clearTimeout(detectionTimeout);
      subscription.unsubscribe();
    };
  }, [connectionStatus, transport, url]);

  useEffect(() => {
    const acquiredByThisApp = authorityStatus === 'acquired' && ownerId === CONTROL_CLIENT_ID;
    if (previouslyAcquiredRef.current && !acquiredByThisApp) {
      useCmdVelStore.getState().clearAll();
    }
    previouslyAcquiredRef.current = acquiredByThisApp;
  }, [authorityStatus, ownerId]);

  useEffect(() => {
    if (connectionStatus !== 'connected' || !transport ||
      authorityStatus !== 'acquired' || ownerId !== CONTROL_CLIENT_ID) return;

    publishControlAction(transport, 'heartbeat');
    const heartbeat = setInterval(() => {
      try {
        publishControlAction(transport, 'heartbeat');
      } catch {
        // The Bridge expires the lease when the transport has already failed.
      }
    }, HEARTBEAT_PERIOD_MS);
    return () => clearInterval(heartbeat);
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

  const acquire = useCallback(() => {
    if (!transport || connectionStatus !== 'connected') return;
    useControlAuthorityStore.getState().beginAcquire();
    try {
      publishControlAction(transport, 'acquire');
    } catch (requestError: any) {
      useControlAuthorityStore.getState().applyStatus({
        state: 'error',
        action: 'acquire',
        clientId: CONTROL_CLIENT_ID,
        reason: requestError?.message ?? String(requestError),
      });
    }
  }, [connectionStatus, transport]);

  const release = useCallback(() => {
    if (!transport || connectionStatus !== 'connected') return;
    useControlAuthorityStore.getState().beginRelease();
    try {
      publishControlAction(transport, 'release');
    } catch (requestError: any) {
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
    if (acquiredByThisApp) {
      Alert.alert(t('authority.releaseTitle'), t('authority.releaseMessage'), [
        { text: t('authority.cancel'), style: 'cancel' },
        { text: t('authority.releaseButton'), style: 'destructive', onPress: release },
      ]);
    } else {
      Alert.alert(t('authority.acquireTitle'), t('authority.acquireMessage'), [
        { text: t('authority.cancel'), style: 'cancel' },
        { text: t('authority.acquireButton'), onPress: acquire },
      ]);
    }
  }, [acquire, ownerId, release, status, t]);

  if (status === 'unsupported' || status === 'disconnected' || url.startsWith('demo://')) {
    return null;
  }

  const acquiredByThisApp = status === 'acquired' && ownerId === CONTROL_CLIENT_ID;
  const disabled = connectionStatus !== 'connected' || status === 'detecting' ||
    status === 'acquiring' || status === 'releasing' || status === 'cooldown' ||
    status === 'owned_by_other';
  const label = status === 'detecting' ? t('authority.detecting')
    : status === 'acquiring' ? t('authority.acquiring')
      : status === 'releasing' ? t('authority.releasing')
        : status === 'cooldown' ? t('authority.cooldown', { seconds: cooldownSeconds })
          : status === 'owned_by_other' ? t('authority.ownedByOther')
            : acquiredByThisApp ? t('authority.releaseButton')
              : status === 'error' ? t('authority.retryButton')
                : t('authority.acquireButton');
  const color = acquiredByThisApp ? theme.colors.statusError
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
          name={disabled ? 'hourglass-outline' : acquiredByThisApp ? 'lock-open-outline' : 'key-outline'}
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
