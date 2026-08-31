import {
  LEGACY_VBOT_TELEOP_TOPIC,
  OMNI_TELEOP_TOPIC,
  defaultUsesTwistStamped,
  getTeleopSafetyPolicy,
  selectPreferredTeleopTarget,
  teleopControlIsBlocked,
  teleopPublishIsBlocked,
  teleopPublishIsBlockedForConnection,
} from '../../lib/teleop';

describe('teleop interface policy', () => {
  it('prefers unified TwistStamped regardless of graph ordering', () => {
    expect(selectPreferredTeleopTarget([
      { name: OMNI_TELEOP_TOPIC, type: 'geometry_msgs/msg/Twist' },
      { name: LEGACY_VBOT_TELEOP_TOPIC, type: 'geometry_msgs/msg/Twist' },
      { name: OMNI_TELEOP_TOPIC, type: 'geometry_msgs/msg/TwistStamped' },
    ])).toEqual({
      topic: OMNI_TELEOP_TOPIC,
      useTwistStamped: true,
    });
  });

  it('recognizes unified teleop from the arbiter status publisher', () => {
    expect(selectPreferredTeleopTarget([
      { name: LEGACY_VBOT_TELEOP_TOPIC, type: 'geometry_msgs/msg/Twist' },
      { name: '/omni/cmd_vel/arbiter_status', type: 'std_msgs/msg/String' },
    ])).toEqual({
      topic: OMNI_TELEOP_TOPIC,
      useTwistStamped: true,
    });
  });

  it.each([OMNI_TELEOP_TOPIC, LEGACY_VBOT_TELEOP_TOPIC])(
    'makes locomotion and control authority mandatory for %s',
    (topic) => {
      expect(getTeleopSafetyPolicy(topic, false)).toEqual({
        requireControlAuthority: true,
        requireLocomotionMode: true,
      });
    },
  );

  it('defaults only the unified input to TwistStamped', () => {
    expect(defaultUsesTwistStamped(OMNI_TELEOP_TOPIC)).toBe(true);
    expect(defaultUsesTwistStamped(LEGACY_VBOT_TELEOP_TOPIC)).toBe(false);
    expect(defaultUsesTwistStamped('/custom/velocity')).toBe(false);
  });

  it.each([OMNI_TELEOP_TOPIC, LEGACY_VBOT_TELEOP_TOPIC])(
    'blocks %s until this App acquires control authority',
    (topic) => {
      expect(teleopControlIsBlocked(topic, false, false)).toBe(true);
      expect(teleopControlIsBlocked(topic, true, false)).toBe(false);
    },
  );

  it('does not let unified teleop bypass authority on an unsupported bridge', () => {
    expect(teleopControlIsBlocked(OMNI_TELEOP_TOPIC, false, true)).toBe(true);
    expect(teleopControlIsBlocked(LEGACY_VBOT_TELEOP_TOPIC, false, true)).toBe(false);
  });

  it('re-evaluates the current owner and blocks a second App, including its zero stream', () => {
    const owner = { status: 'acquired', ownerId: 'app-owner' };
    expect(teleopPublishIsBlocked(OMNI_TELEOP_TOPIC, owner, 'app-owner')).toBe(false);
    expect(teleopPublishIsBlocked(OMNI_TELEOP_TOPIC, owner, 'app-second')).toBe(true);
  });

  it('blocks immediately after authority leaves the acquired state', () => {
    expect(teleopPublishIsBlocked(
      OMNI_TELEOP_TOPIC,
      { status: 'releasing', ownerId: 'app-owner' },
      'app-owner',
    )).toBe(true);
  });

  it('bypasses the lease only for the explicit no-hardware demo connection', () => {
    const unsupported = { status: 'unsupported', ownerId: null };
    expect(teleopPublishIsBlockedForConnection(
      OMNI_TELEOP_TOPIC,
      unsupported,
      'app-demo',
      'demo://localhost',
    )).toBe(false);
    expect(teleopPublishIsBlockedForConnection(
      OMNI_TELEOP_TOPIC,
      unsupported,
      'app-real',
      'ws://robot:9090',
    )).toBe(true);
  });

  it('keeps control authority global while allowing custom topics to opt into locomotion', () => {
    expect(getTeleopSafetyPolicy('/custom/velocity')).toEqual({
      requireControlAuthority: true,
      requireLocomotionMode: false,
    });
    expect(getTeleopSafetyPolicy('/custom/velocity', true)).toEqual({
      requireControlAuthority: true,
      requireLocomotionMode: true,
    });
  });
});
