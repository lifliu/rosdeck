import fs from 'node:fs';
import path from 'node:path';
import {
  createMissionFeedWatchdog,
  MISSION_FEED_STALE_MS,
} from '../../hooks/useMissionFeed';
import { useMissionStore } from '../../stores/useMissionStore';

describe('Mission feed ownership', () => {
  const hook = fs.readFileSync(
    path.join(__dirname, '../../hooks/useMissionFeed.ts'),
    'utf8',
  );
  const root = fs.readFileSync(
    path.join(__dirname, '../../app/_layout.tsx'),
    'utf8',
  );
  const screens = [
    '../../app/(tabs)/index.tsx',
    '../../app/(tabs)/mission.tsx',
    '../../components/ControlCockpit.tsx',
  ].map((file) => fs.readFileSync(path.join(__dirname, file), 'utf8'));

  it('subscribes once from the application root', () => {
    expect(root).toContain('useMissionFeed();');
    expect(hook).toContain('MISSION_STATUS_TOPIC');
    expect(hook).toContain('MISSION_EVENTS_TOPIC');
    expect(hook).toContain('ROBOT_STATE_TOPIC');
    expect(hook).toContain('MISSION_FEED_STALE_MS = 3500');
    expect(hook).toContain('markMissionStatusStale()');
    expect(hook).toContain('markRobotStateStale()');
  });

  it('does not duplicate Mission subscriptions in cached tab screens', () => {
    for (const source of screens) {
      expect(source).not.toContain('MISSION_EVENTS_TOPIC');
      expect(source).not.toContain('MISSION_STATUS_TOPIC');
      expect(source).not.toContain('ROBOT_STATE_TOPIC');
    }
  });
});

describe('Mission feed heartbeat watchdog', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    useMissionStore.getState().resetFeed();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('marks each live snapshot stale independently after its heartbeat expires', () => {
    const onMissionStatusStale = jest.fn();
    const onRobotStateStale = jest.fn();
    const watchdog = createMissionFeedWatchdog(
      onMissionStatusStale,
      onRobotStateStale,
    );

    watchdog.armMissionStatus();
    jest.advanceTimersByTime(MISSION_FEED_STALE_MS - 1);
    expect(onMissionStatusStale).not.toHaveBeenCalled();

    watchdog.armMissionStatus();
    jest.advanceTimersByTime(1000);
    watchdog.armRobotState();
    jest.advanceTimersByTime(MISSION_FEED_STALE_MS - 1000);
    expect(onMissionStatusStale).toHaveBeenCalledTimes(1);
    expect(onRobotStateStale).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1000);
    expect(onRobotStateStale).toHaveBeenCalledTimes(1);

    watchdog.dispose();
  });
});
