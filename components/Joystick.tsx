import * as Haptics from '../lib/haptics';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, Vibration, View } from 'react-native';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { DEFAULTS } from '../constants/defaults';
import { theme } from '../constants/theme';
import { OMNI_BASE_FRAME } from '../lib/frames';
import { useCmdVelPublisher } from '../hooks/useCmdVelPublisher';
import { useTranslation } from '../lib/i18n';
import {
  registerTouchEntry,
  unregisterTouchEntry,
  updateTouchBounds,
} from '../lib/touch-dispatcher';
import { defaultUsesTwistStamped, getTeleopSafetyPolicy } from '../lib/teleop';
import { useCmdVelStore } from '../stores/useCmdVelStore';
import { useGamepadStore } from '../stores/useGamepadStore';
import type { WidgetProps } from '../types/layout';

const SPRING_CONFIG = theme.joystick.springConfig;

const lightTick = () => {
  if (Platform.OS === 'ios') Haptics.selectionAsync();
  else Vibration.vibrate(10);
};

// Robot-frame values: forward = +X, left = +Y, counter-clockwise = +YAW.
export function calculateVelocity(
  dx: number,
  dy: number,
  radius: number,
): { nx: number; ny: number } {
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (distance === 0 || radius <= 0) return { nx: 0, ny: 0 };
  const clampedDist = Math.min(distance, radius);
  const angle = Math.atan2(dy, dx);
  return {
    nx: -(clampedDist * Math.cos(angle)) / radius,
    ny: -(clampedDist * Math.sin(angle)) / radius,
  };
}

/** Normalized YAW for the horizontal-only right stick. */
export function calculateYawVelocity(dx: number, radius: number): number {
  if (radius <= 0 || dx === 0) return 0;
  return -Math.max(-radius, Math.min(radius, dx)) / radius;
}

interface PadProps {
  kind: 'translate' | 'yaw';
  size: number;
  disabled: boolean;
  externalX: number;
  externalY: number;
  label: string;
  hint: string;
  onStart: () => void;
  onChange: (x: number, y: number) => void;
  onEnd: () => void;
  overlay?: boolean;
}

function JoystickPad({
  kind,
  size,
  disabled,
  externalX,
  externalY,
  label,
  hint,
  onStart,
  onChange,
  onEnd,
  overlay = false,
}: PadProps) {
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const activeProgress = useSharedValue(0);
  const knobSize = Math.max(22, size * 0.28);
  const radius = Math.max(1, size / 2 - knobSize / 2);
  const halfRadius = radius * 0.5;
  const radiusRef = useRef(radius);
  const disabledRef = useRef(disabled);
  const onStartRef = useRef(onStart);
  const onChangeRef = useRef(onChange);
  const onEndRef = useRef(onEnd);
  const baseRef = useRef<View>(null);
  const instanceId = useRef(`dual-${kind}-${Math.random().toString(36).slice(2)}`).current;
  const wasAtEdgeRef = useRef(false);
  const previousSignRef = useRef({ x: 0, y: 0 });
  const touchActiveRef = useRef(false);

  radiusRef.current = radius;
  disabledRef.current = disabled;
  onStartRef.current = onStart;
  onChangeRef.current = onChange;
  onEndRef.current = onEnd;

  useEffect(() => {
    registerTouchEntry(instanceId, {
      bounds: null,
      onTouchStart: () => {
        if (disabledRef.current) return;
        touchActiveRef.current = true;
        wasAtEdgeRef.current = false;
        previousSignRef.current = { x: 0, y: 0 };
        activeProgress.value = withTiming(1, { duration: 80 });
        onStartRef.current();
        lightTick();
      },
      onTouchMove: (_touchId, dx, dy) => {
        if (disabledRef.current || !touchActiveRef.current) return;
        const currentRadius = radiusRef.current;
        const effectiveDy = kind === 'yaw' ? 0 : dy;
        const distance = Math.sqrt(dx * dx + effectiveDy * effectiveDy);
        const atEdge = distance >= currentRadius * 0.95;
        if (atEdge && !wasAtEdgeRef.current) lightTick();
        wasAtEdgeRef.current = atEdge;

        const threshold = currentRadius * 0.05;
        const signX = dx > threshold ? 1 : dx < -threshold ? -1 : 0;
        const signY = effectiveDy > threshold ? 1 : effectiveDy < -threshold ? -1 : 0;
        const previous = previousSignRef.current;
        if ((previous.x && signX && previous.x !== signX) ||
            (previous.y && signY && previous.y !== signY)) lightTick();
        if (signX) previous.x = signX;
        if (signY) previous.y = signY;

        if (kind === 'yaw') {
          const clampedX = Math.max(-currentRadius, Math.min(currentRadius, dx));
          translateX.value = clampedX;
          translateY.value = 0;
          onChangeRef.current(calculateYawVelocity(dx, currentRadius), 0);
          return;
        }

        const clampedDistance = Math.min(distance, currentRadius);
        const angle = Math.atan2(dy, dx);
        translateX.value = clampedDistance * Math.cos(angle);
        translateY.value = clampedDistance * Math.sin(angle);
        const value = calculateVelocity(dx, dy, currentRadius);
        onChangeRef.current(value.nx, value.ny);
      },
      onTouchEnd: () => {
        if (!touchActiveRef.current) return;
        touchActiveRef.current = false;
        activeProgress.value = withTiming(0, { duration: 180 });
        translateX.value = withSpring(0, SPRING_CONFIG);
        translateY.value = withSpring(0, SPRING_CONFIG);
        onEndRef.current();
      },
    });
    return () => unregisterTouchEntry(instanceId);
  }, [activeProgress, instanceId, kind, translateX, translateY]);

  useEffect(() => {
    if (!disabled) return;
    translateX.value = -Math.max(-1, Math.min(1, externalX)) * radius;
    translateY.value = kind === 'yaw'
      ? 0
      : -Math.max(-1, Math.min(1, externalY)) * radius;
    const active = Math.abs(externalX) > 0.001 || Math.abs(externalY) > 0.001;
    activeProgress.value = withTiming(active ? 1 : 0, { duration: 80 });
  }, [activeProgress, disabled, externalX, externalY, kind, radius, translateX, translateY]);

  useEffect(() => {
    if (disabled) return;
    translateX.value = withSpring(0, SPRING_CONFIG);
    translateY.value = withSpring(0, SPRING_CONFIG);
    activeProgress.value = withTiming(0, { duration: 100 });
  }, [activeProgress, disabled, translateX, translateY]);

  const knobStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }],
    backgroundColor: interpolateColor(
      activeProgress.value,
      [0, 1],
      ['transparent', theme.colors.accentPrimary],
    ),
  }));

  const updateBounds = () => {
    baseRef.current?.measure((_x, _y, width, height, pageX, pageY) => {
      updateTouchBounds(instanceId, { x: pageX, y: pageY, width, height });
    });
  };

  return (
    <View pointerEvents="box-none" style={[styles.padColumn, { width: size + 12 }]}>
      <View style={overlay ? styles.overlayPadCaption : undefined}>
        <Text style={[styles.padLabel, overlay && styles.overlayPadLabel]}>{label}</Text>
        <Text style={[styles.padHint, overlay && styles.overlayPadHint]}>{hint}</Text>
      </View>
      <View
        ref={baseRef}
        onLayout={updateBounds}
        style={[
          styles.base,
          overlay && styles.overlayBase,
          { width: size, height: size, borderRadius: size / 2 },
        ]}
      >
        <View style={[styles.crosshairH, { width: size * 0.82 }]} />
        {kind === 'translate' && <View style={[styles.crosshairV, { height: size * 0.82 }]} />}
        <View
          style={[
            styles.referenceRing,
            {
              width: halfRadius * 2 + knobSize,
              height: kind === 'yaw' ? knobSize : halfRadius * 2 + knobSize,
              borderRadius: kind === 'yaw' ? knobSize / 2 : (halfRadius * 2 + knobSize) / 2,
            },
          ]}
        />
        <View style={styles.centerDot} />
        <Animated.View
          style={[
            styles.knob,
            { width: knobSize, height: knobSize, borderRadius: knobSize / 2 },
            knobStyle,
          ]}
        />
      </View>
    </View>
  );
}

export function Joystick(props?: Partial<WidgetProps>) {
  const cmdVelTopic = props?.config?.topic || DEFAULTS.cmdVelTopic;
  const useTwistStamped = props?.config?.useTwistStamped ?? defaultUsesTwistStamped(cmdVelTopic);
  const frameId = props?.config?.frameId || OMNI_BASE_FRAME;
  const maxLinearVel = Math.abs(
    props?.config?.maxLinearVel ?? props?.config?.yAxisScale ?? DEFAULTS.maxLinearVel,
  );
  const maxAngularVel = Math.abs(
    props?.config?.maxAngularVel ?? props?.config?.xAxisScale ?? DEFAULTS.maxAngularVel,
  );
  const overlayMode = props?.config?.overlayMode === true;
  const requireLocoMode = getTeleopSafetyPolicy(
    cmdVelTopic,
    props?.config?.requireLocoMode,
  ).requireLocomotionMode;
  const { t } = useTranslation();
  const setAxes = useCmdVelStore((state) => state.setAxes);
  const gamepadConnected = useGamepadStore((state) => state.connected);
  const [display, setDisplay] = useState({ linearX: 0, linearY: 0, angularZ: 0 });
  const displayRef = useRef(display);
  const displayRaf = useRef(false);

  const {
    publishNow,
    prepareLocomotion,
    locoStatus,
    locoError,
    controlBlocked,
  } = useCmdVelPublisher(cmdVelTopic, useTwistStamped, frameId, requireLocoMode);

  const updateDisplay = useCallback((next: Partial<typeof display>) => {
    displayRef.current = { ...displayRef.current, ...next };
    if (displayRaf.current) return;
    displayRaf.current = true;
    requestAnimationFrame(() => {
      displayRaf.current = false;
      setDisplay({ ...displayRef.current });
    });
  }, []);

  const updateTranslation = useCallback((sideways: number, forward: number) => {
    const linearX = forward * maxLinearVel;
    const linearY = sideways * maxLinearVel;
    setAxes(cmdVelTopic, { 'linear.x': linearX, 'linear.y': linearY });
    updateDisplay({ linearX, linearY });
  }, [cmdVelTopic, maxLinearVel, setAxes, updateDisplay]);

  const updateYaw = useCallback((yaw: number) => {
    const angularZ = yaw * maxAngularVel;
    setAxes(cmdVelTopic, { 'angular.z': angularZ });
    updateDisplay({ angularZ });
  }, [cmdVelTopic, maxAngularVel, setAxes, updateDisplay]);

  const stopTranslation = useCallback(() => {
    setAxes(cmdVelTopic, { 'linear.x': 0, 'linear.y': 0 });
    displayRef.current = { ...displayRef.current, linearX: 0, linearY: 0 };
    setDisplay({ ...displayRef.current });
    publishNow();
  }, [cmdVelTopic, publishNow, setAxes]);

  const stopYaw = useCallback(() => {
    setAxes(cmdVelTopic, { 'angular.z': 0 });
    displayRef.current = { ...displayRef.current, angularZ: 0 };
    setDisplay({ ...displayRef.current });
    publishNow();
  }, [cmdVelTopic, publishNow, setAxes]);

  useEffect(() => () => {
    setAxes(cmdVelTopic, { 'linear.x': 0, 'linear.y': 0, 'angular.z': 0 });
  }, [cmdVelTopic, setAxes]);

  useEffect(() => {
    if (!gamepadConnected) return;
    const syncFromStore = (state: ReturnType<typeof useCmdVelStore.getState>) => {
      const axes = state.topics[cmdVelTopic] ?? {};
      const next = {
        linearX: axes['linear.x'] ?? 0,
        linearY: axes['linear.y'] ?? 0,
        angularZ: axes['angular.z'] ?? 0,
      };
      displayRef.current = next;
      setDisplay(next);
    };
    syncFromStore(useCmdVelStore.getState());
    return useCmdVelStore.subscribe(syncFromStore);
  }, [cmdVelTopic, gamepadConnected]);

  const availableWidth = props?.width || 320;
  const availableHeight = props?.height || 280;
  const padSize = overlayMode
    ? Math.max(116, Math.min(188, availableWidth * 0.205, availableHeight * 0.47))
    : Math.max(64, Math.min(250, (availableWidth - 46) / 2, availableHeight - 94));
  const linearScale = maxLinearVel || 1;
  const angularScale = maxAngularVel || 1;

  return (
    <View pointerEvents="box-none" style={[styles.container, overlayMode && styles.overlayContainer]}>
      <View pointerEvents="box-none" style={[styles.padsRow, overlayMode && styles.overlayPadsRow]}>
        <JoystickPad
          kind="translate"
          size={padSize}
          disabled={gamepadConnected}
          externalX={display.linearY / linearScale}
          externalY={display.linearX / linearScale}
          label={t('joystick.translation')}
          hint={t('joystick.translationHint')}
          onStart={prepareLocomotion}
          onChange={updateTranslation}
          onEnd={stopTranslation}
          overlay={overlayMode}
        />
        <JoystickPad
          kind="yaw"
          size={padSize}
          disabled={gamepadConnected}
          externalX={display.angularZ / angularScale}
          externalY={0}
          label={t('joystick.yaw')}
          hint={t('joystick.yawHint')}
          onStart={prepareLocomotion}
          onChange={(yaw) => updateYaw(yaw)}
          onEnd={stopYaw}
          overlay={overlayMode}
        />
      </View>

      {!overlayMode && (
        <View pointerEvents="none" style={styles.readoutRow}>
          <Text style={styles.readoutText}>
            X {display.linearX.toFixed(2)} · Y {display.linearY.toFixed(2)} m/s
          </Text>
          <Text style={styles.readoutText}>YAW {display.angularZ.toFixed(2)} rad/s</Text>
        </View>
      )}

      {gamepadConnected && (
        <View style={styles.gamepadBadge}>
          <Text style={styles.gamepadBadgeText}>{t('joystick.gamepadDual')}</Text>
        </View>
      )}
      {controlBlocked ? (
        <View style={[styles.statusBadge, styles.controlBlockedBadge]}>
          <Text style={[styles.statusBadgeText, styles.controlBlockedText]} numberOfLines={1}>
            {t('joystick.takeControl')}
          </Text>
        </View>
      ) : requireLocoMode && locoStatus !== 'idle' ? (
        <View style={styles.statusBadge}>
          <Text
            style={[styles.statusBadgeText, locoStatus === 'error' && styles.locoErrorText]}
            numberOfLines={1}
          >
            {locoStatus === 'switching'
              ? t('joystick.locoSwitching')
              : locoStatus === 'ready'
                ? t('joystick.locoReady')
                : t('joystick.locoError')}
          </Text>
        </View>
      ) : null}
      {requireLocoMode && locoStatus === 'error' && locoError && (
        <Text style={styles.locoErrorDetail} numberOfLines={1}>{locoError}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8, paddingVertical: 6 },
  padsRow: { width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-evenly', gap: 10 },
  padColumn: { alignItems: 'center' },
  padLabel: { color: theme.colors.textPrimary, fontSize: 12, fontWeight: '700', letterSpacing: 0.4 },
  padHint: { color: theme.colors.textMuted, fontSize: 9, marginTop: 1, marginBottom: 6 },
  base: { backgroundColor: theme.colors.bgSurface, borderWidth: 1, borderColor: theme.colors.borderSubtle, alignItems: 'center', justifyContent: 'center' },
  overlayContainer: { justifyContent: 'flex-end', paddingHorizontal: 22, paddingBottom: 15, paddingTop: 4 },
  overlayPadsRow: { justifyContent: 'space-between', alignItems: 'flex-end', paddingHorizontal: 2 },
  overlayPadCaption: { minWidth: 96, alignItems: 'center', borderRadius: 10, backgroundColor: '#061014B8', paddingHorizontal: 10, paddingTop: 5, paddingBottom: 4, marginBottom: 6, borderWidth: 1, borderColor: '#FFFFFF18' },
  overlayPadLabel: { fontSize: 11, color: '#FFFFFF' },
  overlayPadHint: { marginBottom: 0, color: '#B9C7CC' },
  overlayBase: { backgroundColor: '#071116B8', borderColor: '#FFFFFF35', borderWidth: 1.5 },
  crosshairH: { position: 'absolute', height: 1, backgroundColor: '#FFFFFF0A' },
  crosshairV: { position: 'absolute', width: 1, backgroundColor: '#FFFFFF0A' },
  referenceRing: { position: 'absolute', borderWidth: 1, borderColor: '#FFFFFF0B' },
  centerDot: { position: 'absolute', width: 4, height: 4, borderRadius: 2, backgroundColor: '#FFFFFF18' },
  knob: {
    borderWidth: 1.5,
    borderColor: theme.colors.accentPrimary,
    ...Platform.select({
      ios: { shadowColor: theme.colors.accentPrimary, shadowRadius: 10, shadowOpacity: 0.35, shadowOffset: { width: 0, height: 0 } },
      android: { filter: [{ dropShadow: { offsetX: 0, offsetY: 0, standardDeviation: 6, color: theme.colors.accentPrimary + '88' } }] },
    }),
  } as any,
  readoutRow: { width: '100%', flexDirection: 'row', justifyContent: 'space-around', marginTop: 5, paddingHorizontal: 6 },
  readoutText: { flex: 1, fontFamily: 'SpaceMono', fontSize: 9, color: theme.colors.textMuted, textAlign: 'center' },
  gamepadBadge: { position: 'absolute', top: 4, right: 6, backgroundColor: theme.colors.accentPrimary + '26', borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 },
  gamepadBadgeText: { fontFamily: 'SpaceMono', fontSize: 8, color: theme.colors.accentPrimary, fontWeight: '700' },
  statusBadge: { position: 'absolute', top: 4, left: 6, backgroundColor: theme.colors.statusConnected + '22', borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2, maxWidth: '48%' },
  statusBadgeText: { fontFamily: 'SpaceMono', fontSize: 8, color: theme.colors.statusConnected, fontWeight: '700' },
  controlBlockedBadge: { backgroundColor: theme.colors.statusConnecting + '22' },
  controlBlockedText: { color: theme.colors.statusConnecting },
  locoErrorText: { color: theme.colors.statusError },
  locoErrorDetail: { fontFamily: 'SpaceMono', fontSize: 8, color: theme.colors.statusError, maxWidth: '90%', marginTop: 2 },
});
