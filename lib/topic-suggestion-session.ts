import type { TopicSuggestion } from './topic-detection';
import { OMNI_TELEOP_TOPIC } from './teleop';

export interface TopicSuggestionSource {
  url: string;
  transport: unknown;
}

export interface TopicSuggestionSession {
  source: TopicSuggestionSource;
  suggestion: TopicSuggestion;
}

export interface CurrentTopicSuggestionSource {
  url: string;
  transport: unknown;
  layoutRobotUrl: string | null;
}

export function createTopicSuggestionSession(
  source: TopicSuggestionSource,
  suggestion: TopicSuggestion,
): TopicSuggestionSession {
  return { source, suggestion };
}

/**
 * Refresh an already visible suggestion only for the same live connection.
 * The canonical product input is intentionally stricter than a generic topic:
 * it must remain TwistStamped before it can replace a working VBot proposal.
 */
export function refreshTopicSuggestionSession(
  session: TopicSuggestionSession | null,
  source: TopicSuggestionSource,
  suggestion: TopicSuggestion | null,
): TopicSuggestionSession | null {
  if (!session || !suggestion || session.source.url !== source.url ||
    session.source.transport !== source.transport) {
    return session;
  }
  const joystick = suggestion.widgetConfigs.joystick;
  if (joystick?.topic !== OMNI_TELEOP_TOPIC || joystick.useTwistStamped !== true) {
    return session;
  }
  return { source: session.source, suggestion };
}

/**
 * Validate the modal's source at the exact moment its Accept action runs.
 * Object identity for `transport` prevents an old socket/modal from mutating a
 * newly connected robot even when both connections use the same URL.
 */
export function acceptTopicSuggestionSession(
  session: TopicSuggestionSession | null,
  current: CurrentTopicSuggestionSource,
): TopicSuggestionSession | null {
  return session && topicSuggestionSourceIsCurrent(session.source, current)
    ? session
    : null;
}

export function topicSuggestionSourceIsCurrent(
  source: TopicSuggestionSource,
  current: CurrentTopicSuggestionSource,
): boolean {
  return source.url === current.url && source.transport === current.transport &&
    current.layoutRobotUrl === source.url;
}
