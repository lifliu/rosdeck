import { suggestLayout } from '../../lib/topic-detection';
import {
  acceptTopicSuggestionSession,
  createTopicSuggestionSession,
  refreshTopicSuggestionSession,
  topicSuggestionSourceIsCurrent,
  type CurrentTopicSuggestionSource,
  type TopicSuggestionSession,
} from '../../lib/topic-suggestion-session';
import type { TopicInfo } from '../../lib/transport';

describe('ControlScreen topic suggestion session', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('refreshes a visible /vel_cmd proposal when arbiter status appears on a later probe', async () => {
    const transport = {};
    const source = { url: 'ws://robot-a:9090', transport };
    const responses: TopicInfo[][] = [
      [{ name: '/vel_cmd', type: 'geometry_msgs/msg/Twist' }],
      [
        { name: '/vel_cmd', type: 'geometry_msgs/msg/Twist' },
        { name: '/omni/cmd_vel/arbiter_status', type: 'std_msgs/msg/String' },
      ],
    ];
    const getTopics = jest.fn()
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1]);
    let session: TopicSuggestionSession | null = null;

    const probe = async (offerInitial: boolean) => {
      const candidate = suggestLayout(await getTopics());
      if (offerInitial && candidate) {
        session = createTopicSuggestionSession(source, candidate);
      } else {
        session = refreshTopicSuggestionSession(session, source, candidate);
      }
    };

    // These are ControlScreen's production discovery delays: an initial probe
    // after 500 ms, followed by one-second retries while the graph settles.
    setTimeout(() => { void probe(true); }, 500);
    setTimeout(() => { void probe(false); }, 1500);

    await jest.advanceTimersByTimeAsync(499);
    expect(session).toBeNull();

    await jest.advanceTimersByTimeAsync(1);
    const initialSession = session as TopicSuggestionSession | null;
    expect(initialSession?.suggestion.widgetConfigs.joystick).toEqual({
      topic: '/vel_cmd',
      useTwistStamped: false,
      requireLocoMode: true,
    });

    await jest.advanceTimersByTimeAsync(1000);
    const refreshedSession = session as TopicSuggestionSession | null;
    expect(refreshedSession?.source).toBe(source);
    expect(refreshedSession?.suggestion.widgetConfigs.joystick).toEqual({
      topic: '/omni/cmd_vel/teleop',
      useTwistStamped: true,
      requireLocoMode: true,
    });
    expect(getTopics).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: 'robot and transport change',
      next: {
        url: 'ws://robot-b:9090',
        transport: {},
        layoutRobotUrl: 'ws://robot-b:9090',
      },
    },
    {
      name: 'transport is replaced at the same URL',
      next: {
        url: 'ws://robot-a:9090',
        transport: {},
        layoutRobotUrl: 'ws://robot-a:9090',
      },
    },
  ])('rejects an old modal after $name', async ({ next }) => {
    const originalTransport = {};
    const source = { url: 'ws://robot-a:9090', transport: originalTransport };
    const suggestion = suggestLayout([
      { name: '/vel_cmd', type: 'geometry_msgs/msg/Twist' },
    ]);
    expect(suggestion).not.toBeNull();
    const oldModalSession = createTopicSuggestionSession(source, suggestion!);
    let current: CurrentTopicSuggestionSource = {
      url: source.url,
      transport: originalTransport,
      layoutRobotUrl: source.url,
    };
    let accepted: TopicSuggestionSession | null | undefined;

    setTimeout(() => { current = next; }, 500);
    setTimeout(() => {
      accepted = acceptTopicSuggestionSession(oldModalSession, current);
    }, 1000);

    await jest.advanceTimersByTimeAsync(1000);
    expect(accepted).toBeNull();
    // The same identity check is also used by ControlScreen's delayed config
    // write, so a stale zero-delay callback cannot mutate the new layout.
    expect(topicSuggestionSourceIsCurrent(source, current)).toBe(false);
  });

  it('accepts the current modal for the same robot, layout, and transport', () => {
    const transport = {};
    const source = { url: 'ws://robot-a:9090', transport };
    const suggestion = suggestLayout([
      { name: '/vel_cmd', type: 'geometry_msgs/msg/Twist' },
    ]);
    const session = createTopicSuggestionSession(source, suggestion!);
    const current = {
      url: source.url,
      transport,
      layoutRobotUrl: source.url,
    };

    expect(acceptTopicSuggestionSession(session, current)).toBe(session);
    expect(topicSuggestionSourceIsCurrent(source, current)).toBe(true);
  });

  it('does not refresh a VBot proposal from a non-canonical unified Twist topic', () => {
    const source = { url: 'ws://robot-a:9090', transport: {} };
    const legacy = suggestLayout([
      { name: '/vel_cmd', type: 'geometry_msgs/msg/Twist' },
    ]);
    const nonCanonical = suggestLayout([
      { name: '/vel_cmd', type: 'geometry_msgs/msg/Twist' },
      { name: '/omni/cmd_vel/teleop', type: 'geometry_msgs/msg/Twist' },
    ]);
    const session = createTopicSuggestionSession(source, legacy!);

    expect(refreshTopicSuggestionSession(session, source, nonCanonical)).toBe(session);
  });
});
