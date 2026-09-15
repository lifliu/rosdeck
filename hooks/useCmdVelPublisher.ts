import { useCallback, useEffect, useRef } from 'react';
import {
  buildTeleopCommandMessage,
  buildTwistStampedMessage,
  createCmdVelTopic,
} from '../lib/ros';
import { useCmdVelStore } from '../stores/useCmdVelStore';
import { useRosStore } from '../stores/useRosStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import type { TwistMessage } from '../types/ros';
import type { TwistField } from '../lib/ros';
import {
  ensureLocoMode,
  isLocoModeReady,
  resetLocomotionModeState,
} from '../lib/locomotion-mode';
import { useLocomotionModeStore } from '../stores/useLocomotionModeStore';
import {
  useControlAuthorityStore,
} from '../stores/useControlAuthorityStore';
import {
  defaultUsesTwistStamped,
  getTeleopSafetyPolicy,
  OMNI_TELEOP_TOPIC,
  TELEOP_COMMAND_MESSAGE_TYPE,
  teleopPublishIsBlockedForConnection,
} from '../lib/teleop';
import { CONTROL_CLIENT_ID } from '../lib/control-authority';

// Module-level singletons — one interval per topic, shared across all joystick instances.
// Using a Set of publish fns so that when one joystick unmounts, the interval
// seamlessly falls over to the next registered one.
const _intervals = new Map<string, ReturnType<typeof setInterval>>();
const _publishFns = new Map<string, Set<() => void>>();

// Restart all active intervals when publish rate changes.
// Set up once at module load time; runs for app lifetime.
// Uses single-argument subscribe (works without subscribeWithSelector middleware)
// with manual comparison against a cached previous value.
let _lastPublishRate = useSettingsStore.getState().publishRateHz;
useSettingsStore.subscribe((state) => {
  if (state.publishRateHz !== _lastPublishRate) {
    _lastPublishRate = state.publishRateHz;
    const newRate = state.publishRateHz;
    for (const [topic, interval] of _intervals.entries()) {
      clearInterval(interval);
      _intervals.set(
        topic,
        setInterval(() => {
          const fns = _publishFns.get(topic);
          if (fns && fns.size > 0) {
            fns.values().next().value!();
          }
        }, 1000 / newRate),
      );
    }
  }
});

function buildTwistFromAxes(axes: Record<string, number>): TwistMessage {
  const twist: TwistMessage = { linear: { x: 0, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0 } };
  for (const [field, value] of Object.entries(axes) as [TwistField, number][]) {
    const [group, axis] = field.split('.') as ['linear' | 'angular', 'x' | 'y' | 'z'];
    if (twist[group]) {
      twist[group][axis] = value ?? 0;
    }
  }
  return twist;
}

export function useCmdVelPublisher(
  topic: string,
  useTwistStamped: boolean,
  frameId: string,
  requireLocoMode = false,
): {
  publishNow: () => void;
  prepareLocomotion: () => void;
  locoStatus: ReturnType<typeof useLocomotionModeStore.getState>['status'];
  locoError: string | null;
  controlBlocked: boolean;
} {
  const ros = useRosStore((s) => s.connection.ros);
  const connectionUrl = useRosStore((s) => s.connection.url);
  const transport = useRosStore((s) => s.transport);
  const status = useRosStore((s) => s.connection.status);
  const locoStatus = useLocomotionModeStore((s) => s.status);
  const locoError = useLocomotionModeStore((s) => s.error);
  const authorityStatus = useControlAuthorityStore((s) => s.status);
  const authorityOwner = useControlAuthorityStore((s) => s.ownerId);
  const roslibTopicRef = useRef<any>(null);
  // Track which messageType the current roslibTopic was advertised with,
  // so we can guard against the render→effect race and config mismatches.
  const roslibTopicTypeRef = useRef<string | null>(null);
  const roslibTopicNameRef = useRef<string | null>(null);
  const roslibRosRef = useRef<any>(null);
  const teleopSequenceRef = useRef(0);
  const previousTransportRef = useRef(transport);
  const safetyPolicy = getTeleopSafetyPolicy(topic, requireLocoMode);
  const publishAuthenticatedTeleop = topic === OMNI_TELEOP_TOPIC;
  // 旧版速度话题继续遵循布局里的 Twist/TwistStamped 配置；产品入口固定使用
  // TeleopCommand，不能被历史布局中的 useTwistStamped 覆盖。
  const publishTwistStamped = !publishAuthenticatedTeleop &&
    (defaultUsesTwistStamped(topic) || useTwistStamped);
  const isDemoConnection = connectionUrl.startsWith('demo://');
  const controlBlocked = teleopPublishIsBlockedForConnection(
    topic,
    { status: authorityStatus, ownerId: authorityOwner },
    CONTROL_CLIENT_ID,
    connectionUrl,
  );

  useEffect(() => {
    // LOCO approval belongs to the current authority session, not the socket.
    // Reacquiring after a lease timeout must obtain a fresh mode approval.
    resetLocomotionModeState();
  }, [authorityStatus, authorityOwner]);

  useEffect(() => {
    if (!transport || status !== 'connected') return;
    const posture = transport.subscribe('/rosdeck/posture_status', 'std_msgs/msg/String', () => {
      resetLocomotionModeState();
    });
    return () => posture.unsubscribe();
  }, [transport, status]);

  useEffect(() => {
    if (previousTransportRef.current !== transport || status !== 'connected') {
      resetLocomotionModeState();
      previousTransportRef.current = transport;
    }
  }, [transport, status]);

  useEffect(() => {
    // Unadvertise old topic before replacing — prevents rosbridge from keeping
    // the old type registration alive when useTwistStamped changes.
    roslibTopicRef.current?.unadvertise?.();
    roslibTopicRef.current = null;
    roslibTopicTypeRef.current = null;
    roslibTopicNameRef.current = null;
    roslibRosRef.current = null;

    if (ros && status === 'connected') {
      const messageType = publishAuthenticatedTeleop
        ? TELEOP_COMMAND_MESSAGE_TYPE
        : publishTwistStamped
        ? 'geometry_msgs/msg/TwistStamped'
        : 'geometry_msgs/msg/Twist';
      roslibTopicRef.current = createCmdVelTopic(
        ros, topic, publishTwistStamped, messageType);
      roslibTopicTypeRef.current = messageType;
      roslibTopicNameRef.current = topic;
      roslibRosRef.current = ros;
    }

    return () => {
      roslibTopicRef.current?.unadvertise?.();
      roslibTopicRef.current = null;
      roslibTopicTypeRef.current = null;
      roslibTopicNameRef.current = null;
      roslibRosRef.current = null;
    };
  }, [ros, status, topic, publishAuthenticatedTeleop, publishTwistStamped]);

  // publishRef is updated every render so the interval always calls fresh logic.
  const publishRef = useRef<() => void>(() => {});
  publishRef.current = () => {
    // The interval outlives individual React renders. Re-read authority for
    // every message so a release/takeover takes effect immediately. Block all
    // regular publications, including zero, from non-owners: without a source
    // identity on Twist, another connected App's zero stream could otherwise
    // override the real owner's teleop stream.
    const currentAuthority = useControlAuthorityStore.getState();
    if (safetyPolicy.requireControlAuthority && teleopPublishIsBlockedForConnection(
      topic,
      { status: currentAuthority.status, ownerId: currentAuthority.ownerId },
      CONTROL_CLIENT_ID,
      connectionUrl,
    )) {
      return;
    }

    const axes = useCmdVelStore.getState().topics[topic] ?? {};
    const twist = buildTwistFromAxes(axes);
    teleopSequenceRef.current += 1;
    const msg = publishAuthenticatedTeleop
      ? buildTeleopCommandMessage(
        twist, frameId, CONTROL_CLIENT_ID, teleopSequenceRef.current)
      : publishTwistStamped
        ? buildTwistStampedMessage(twist, frameId)
        : twist;
    const messageType = publishAuthenticatedTeleop
      ? TELEOP_COMMAND_MESSAGE_TYPE
      : publishTwistStamped
      ? 'geometry_msgs/msg/TwistStamped'
      : 'geometry_msgs/msg/Twist';

    const hasMotion = Object.values(axes).some((value) => Math.abs(value ?? 0) > 0.0001);
    if (safetyPolicy.requireLocomotionMode && !isDemoConnection && hasMotion && transport &&
        status === 'connected' &&
        !isLocoModeReady(transport)) {
      void ensureLocoMode(transport)
        .then(() => publishRef.current())
        .catch(() => {});
      return;
    }

    // Only publish via roslib Topic if its advertised type still matches the
    // current config — guards the render→effect race window.
    if (roslibTopicRef.current &&
        roslibTopicTypeRef.current === messageType &&
        roslibTopicNameRef.current === topic &&
        roslibRosRef.current === ros) {
      roslibTopicRef.current.publish(msg);
    } else if (transport && status === 'connected') {
      transport.publish(topic, messageType, msg);
    }
  };

  // Stable wrapper so we can remove it from the Set on unmount.
  const stableWrapperRef = useRef<() => void>(() => publishRef.current());

  useEffect(() => {
    const myFn = stableWrapperRef.current;

    if (!_publishFns.has(topic)) {
      _publishFns.set(topic, new Set());
    }
    _publishFns.get(topic)!.add(myFn);

    if (!_intervals.has(topic)) {
      _intervals.set(
        topic,
        setInterval(() => {
          const fns = _publishFns.get(topic);
          if (fns && fns.size > 0) {
            // Any fn works — they all read from the same store.
            fns.values().next().value!();
          }
        }, 1000 / useSettingsStore.getState().publishRateHz),
      );
    }

    return () => {
      _publishFns.get(topic)?.delete(myFn);
      if (_publishFns.get(topic)?.size === 0) {
        clearInterval(_intervals.get(topic));
        _intervals.delete(topic);
        _publishFns.delete(topic);
      }
    };
  }, [topic]);

  const prepareLocomotion = useCallback(() => {
    if (!safetyPolicy.requireLocomotionMode || isDemoConnection || !transport ||
      status !== 'connected' ||
      controlBlocked) return;
    void ensureLocoMode(transport).catch(() => {});
  }, [safetyPolicy.requireLocomotionMode, isDemoConnection, transport, status, controlBlocked]);

  return {
    publishNow: () => publishRef.current(),
    prepareLocomotion,
    locoStatus,
    locoError,
    controlBlocked,
  };
}
