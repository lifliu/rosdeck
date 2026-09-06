import { Ionicons } from "@expo/vector-icons";
import React, { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { theme } from "../constants/theme";
import { SetupGuide } from "./SetupGuide";
import { useSettingsStore } from "../stores/useSettingsStore";

interface Props {
  widgetType: string;
  topicName: string;
  hint?: string;
}

const WIDGET_HELP: Record<
  string,
  { icon: string; message: string; hint: string }
> = {
  camera: {
    icon: "videocam-outline",
    message: "No image on",
    hint: "Is web_video_server running?",
  },
  map: {
    icon: "map-outline",
    message: "No occupancy grid on",
    hint: "Is your SLAM node running?",
  },
  laserscan: {
    icon: "radio-outline",
    message: "No scan data on",
    hint: "Is your lidar node running?",
  },
  imu: {
    icon: "compass-outline",
    message: "No IMU data on",
    hint: "Check your IMU driver.",
  },
  diagnostics: {
    icon: "pulse-outline",
    message: "No diagnostics on",
    hint: "Is diagnostic_aggregator running?",
  },
  rosout: {
    icon: "terminal-outline",
    message: "No log messages on",
    hint: "",
  },
  "tf-tree": {
    icon: "git-branch-outline",
    message: "No transforms received yet.",
    hint: "",
  },
  "topic-viewer": {
    icon: "code-slash-outline",
    message: "No messages on",
    hint: "",
  },
  battery: {
    icon: "battery-half-outline",
    message: "No battery data on",
    hint: "Is your battery driver publishing sensor_msgs/BatteryState?",
  },
  pointcloud3d: {
    icon: "cube-outline",
    message: "No registered point cloud on",
    hint: "Start 3D mapping to begin the live preview.",
  },
};

export function WidgetEmptyState({
  widgetType,
  topicName,
  hint: hintOverride,
}: Props) {
  const [showGuide, setShowGuide] = useState(false);
  const language = useSettingsStore((s) => s.language);
  const help = WIDGET_HELP[widgetType] ?? {
    icon: "help-circle-outline",
    message: "No data on",
    hint: "",
  };

  const hasTopicInMessage = help.message.endsWith("on");

  return (
    <View style={styles.container}>
      <Ionicons
        name={help.icon as any}
        size={32}
        color={theme.colors.textMuted}
      />
      <Text style={styles.message}>
        {hasTopicInMessage ? `${help.message} ${topicName}` : help.message}
      </Text>
      {(hintOverride ?? help.hint) ? (
        <Text style={styles.hint}>{hintOverride ?? help.hint}</Text>
      ) : null}
      <TouchableOpacity
        style={styles.guideButton}
        onPress={() => setShowGuide(true)}
      >
        <Text style={styles.guideText}>{language === 'zh' ? '查看连接帮助' : 'Connection help'}</Text>
      </TouchableOpacity>
      <SetupGuide visible={showGuide} onClose={() => setShowGuide(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
    gap: 8,
    backgroundColor: theme.colors.bgBase,
  },
  message: {
    fontSize: 14,
    fontWeight: '600',
    color: theme.colors.textSecondary,
    textAlign: "center",
    marginTop: 8,
  },
  hint: {
    fontSize: 12,
    lineHeight: 17,
    color: theme.colors.textMuted,
    textAlign: "center",
  },
  guideButton: {
    marginTop: 12,
    minHeight: 42,
    justifyContent: 'center',
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: theme.colors.borderDefault,
    borderRadius: theme.radius.md,
  },
  guideText: {
    fontSize: 12,
    fontWeight: "700",
    color: theme.colors.accentPrimary,
  },
});
