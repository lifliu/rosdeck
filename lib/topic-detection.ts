import type { TopicInfo } from './transport';

export interface DetectedTopic {
  name: string;
  type: string;
  widgetType: string;
}

export interface TopicSuggestion {
  presetId: string;
  detectedTopics: DetectedTopic[];
  widgetConfigs: Record<string, Record<string, any>>;
}

const TYPE_TO_WIDGET: Array<{ pattern: RegExp; widgetType: string; configKey: string }> = [
  { pattern: /OccupancyGrid/, widgetType: 'map', configKey: 'topic' },
  { pattern: /DiagnosticArray/, widgetType: 'diagnostics', configKey: 'topic' },
  { pattern: /BatteryState/, widgetType: 'battery', configKey: 'topic' },
];

function hasTwist(topics: TopicInfo[]): TopicInfo | undefined {
  const twistTopics = topics.filter((t) => /Twist/.test(t.type));
  return twistTopics.find(
    (t) => t.name === '/vel_cmd' && t.type === 'geometry_msgs/msg/Twist',
  ) ?? twistTopics.find((t) => t.name === '/vel_cmd')
    ?? twistTopics.find((t) => t.name === '/cmd_vel')
    ?? twistTopics[0];
}

export function suggestLayout(topics: TopicInfo[]): TopicSuggestion | null {
  if (topics.length === 0) return null;

  const detected: DetectedTopic[] = [];
  const widgetConfigs: Record<string, Record<string, any>> = {};

  for (const topic of topics) {
    for (const mapping of TYPE_TO_WIDGET) {
      if (mapping.pattern.test(topic.type)) {
        detected.push({ name: topic.name, type: topic.type, widgetType: mapping.widgetType });
        widgetConfigs[mapping.widgetType] = { [mapping.configKey]: topic.name };
        break;
      }
    }
  }

  // Camera: prefer Foxglove encoded video, then CompressedImage.
  // Raw Image is never processed (multi-MB frames would freeze the app).
  const cameraTopic = topics.find((t) =>
    t.type === 'foxglove_msgs/msg/CompressedVideo'
  ) ?? topics.find((t) =>
    t.type === 'sensor_msgs/msg/CompressedImage' &&
    !/[Dd]epth|theora/.test(t.name)
  );
  if (cameraTopic) {
    detected.push({ name: cameraTopic.name, type: cameraTopic.type, widgetType: 'camera' });
    widgetConfigs.camera = { topic: cameraTopic.name, source: 'transport' };
  }

  const twistTopic = hasTwist(topics);
  if (twistTopic) {
    detected.push({ name: twistTopic.name, type: twistTopic.type, widgetType: 'joystick' });
    widgetConfigs.joystick = {
      topic: twistTopic.name,
      useTwistStamped: /TwistStamped$/.test(twistTopic.type),
    };
  }

  if (detected.length === 0) return null;

  const hasImage = detected.some((d) => d.widgetType === 'camera');
  const hasMap = detected.some((d) => d.widgetType === 'map');
  const hasTwistTopic = !!twistTopic;

  let presetId: string;
  if (hasImage && hasMap && hasTwistTopic) {
    presetId = 'dashboard';
  } else if (hasMap && hasTwistTopic) {
    presetId = 'nav';
  } else if (hasImage && hasTwistTopic) {
    presetId = 'drive-camera';
  } else if (hasImage) {
    presetId = 'camera-only';
  } else {
    presetId = 'drive';
  }

  return { presetId, detectedTopics: detected, widgetConfigs };
}
