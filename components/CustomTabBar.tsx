import { Ionicons } from "@expo/vector-icons";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { useNavigationState } from "@react-navigation/native";
import { useRouter, useSegments } from "expo-router";
import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { theme } from "../constants/theme";
import { useLayoutStore } from "../stores/useLayoutStore";
import { useRosStore } from "../stores/useRosStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useProductCopy, type ProductCopyKey } from "../lib/product-copy";

export const RAIL_WIDTH = 64;

const TAB_CONFIG: Record<
  string,
  { labelKey: ProductCopyKey; icon: keyof typeof Ionicons.glyphMap }
> = {
  index: { labelKey: "tabs.home", icon: "home-outline" },
  device: { labelKey: "tabs.device", icon: "hardware-chip-outline" },
  control: { labelKey: "tabs.control", icon: "game-controller-outline" },
  mission: { labelKey: "tabs.mission", icon: "clipboard-outline" },
  settings: { labelKey: "tabs.settings", icon: "settings-outline" },
};

const TAB_ROUTES = ["index", "device", "control", "mission", "settings"];

/**
 * Portrait bottom tab bar — rendered via Tabs tabBar prop
 */
export function CustomTabBar({
  state,
  descriptors,
  navigation,
}: BottomTabBarProps) {
  const connectionStatus = useRosStore((s) => s.connection.status);
  const isConnected = connectionStatus === "connected";
  const insets = useSafeAreaInsets();
  const { pc } = useProductCopy();

  if (state.routes[state.index]?.name === 'control') return null;

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <View style={styles.tabBar}>
        {state.routes.map((route, index) => {
          const { options } = descriptors[route.key];
          const isFocused = state.index === index;
          const config = TAB_CONFIG[route.name];

          const onPress = () => {
            const event = navigation.emit({
              type: "tabPress",
              target: route.key,
              canPreventDefault: true,
            });
            if (!isFocused && !event.defaultPrevented) {
              navigation.navigate(route.name);
            }
          };

          const onLongPress = () => {
            navigation.emit({
              type: "tabLongPress",
              target: route.key,
            });
          };

          const color = isFocused
            ? theme.colors.accentPrimary
            : theme.colors.textMuted;

          return (
            <TouchableOpacity
              key={route.key}
              accessibilityRole="button"
              accessibilityState={isFocused ? { selected: true } : {}}
              accessibilityLabel={options.tabBarAccessibilityLabel}
              onPress={onPress}
              onLongPress={onLongPress}
              style={styles.tab}
              activeOpacity={0.7}
            >
              <View style={styles.labelContainer}>
                <Ionicons
                  name={config?.icon ?? 'ellipse-outline'}
                  size={21}
                  color={color}
                />
                <Text style={[styles.label, { color }]} numberOfLines={1}>
                  {config ? pc(config.labelKey) : route.name}
                </Text>
                {route.name === "index" && isConnected && (
                  <View style={styles.statusDot} />
                )}
              </View>
              {isFocused && <View style={styles.activeIndicator} />}
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

/**
 * Landscape side rail — rendered as a sibling to Tabs in _layout.tsx
 */
export function LandscapeTabRail() {
  const connectionStatus = useRosStore((s) => s.connection.status);
  const isConnected = connectionStatus === "connected";
  const insets = useSafeAreaInsets();
  const railSide = useSettingsStore((s) => s.tabRailSide);
  const router = useRouter();
  const segments = useSegments();
  const editMode = useLayoutStore((s) => s.editMode);
  const setEditMode = useLayoutStore((s) => s.setEditMode);
  const { pc } = useProductCopy();

  // Determine active tab from route segments
  // (expo-router 55 types useSegments() as a 1-tuple by default; the hook
  // actually returns the full segment array at runtime)
  const currentSegment = (segments as readonly string[])[1] || "index";
  const activeIndex = TAB_ROUTES.indexOf(currentSegment);
  const isOnControlTab = currentSegment === "control";

  const isLeft = railSide === "left";
  const sideInset = isLeft ? insets.left : insets.right;

  return (
    <View
      style={[
        styles.railContainer,
        isLeft
          ? { borderRightWidth: 1, borderLeftWidth: 0, paddingLeft: sideInset }
          : { borderLeftWidth: 1, borderRightWidth: 0, paddingRight: sideInset },
        { width: RAIL_WIDTH + sideInset },
      ]}
    >
      {TAB_ROUTES.map((routeName, index) => {
        const isFocused = index === activeIndex;
        const config = TAB_CONFIG[routeName];
        const iconColor = isFocused
          ? theme.colors.accentPrimary
          : theme.colors.textMuted;

        return (
          <TouchableOpacity
            key={routeName}
            accessibilityRole="button"
            accessibilityState={isFocused ? { selected: true } : {}}
            accessibilityLabel={pc(config.labelKey)}
            onPress={() => {
              if (routeName === "index") router.push("/(tabs)");
              else router.push(`/(tabs)/${routeName}` as any);
            }}
            style={[styles.railTab, isFocused && styles.railTabActive]}
            activeOpacity={0.7}
          >
            <Ionicons name={config.icon} size={22} color={iconColor} />
            {routeName === "index" && isConnected && (
              <View style={styles.railStatusDot} />
            )}
          </TouchableOpacity>
        );
      })}

      {/* Layout controls on control tab */}
      {isOnControlTab && (
        <View style={styles.railControls}>
          <View style={styles.railDivider} />
          <TouchableOpacity
            style={styles.railTab}
            onPress={() => {
              useLayoutStore.setState({ layoutListOpen: true });
            }}
            activeOpacity={0.7}
          >
            <Ionicons
              name="layers-outline"
              size={20}
              color={theme.colors.textMuted}
            />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.railTab, editMode && styles.railEditActive]}
            onPress={() => setEditMode(!editMode)}
            activeOpacity={0.7}
          >
            <Ionicons
              name={editMode ? "checkmark" : "pencil-outline"}
              size={20}
              color={editMode ? "#FFFFFF" : theme.colors.textMuted}
            />
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Portrait bottom bar
  container: {
    backgroundColor: theme.colors.bgBase,
  },
  tabBar: {
    flexDirection: "row",
    backgroundColor: theme.colors.bgBase,
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderSubtle,
    minHeight: theme.sizes.bottomBar,
    paddingTop: 7,
    paddingBottom: 6,
    marginHorizontal: 0,
  },
  tab: {
    flex: 1,
    minHeight: 54,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  labelContainer: {
    flexDirection: "column",
    alignItems: "center",
    gap: 3,
  },
  statusDot: {
    position: "absolute",
    top: 1,
    right: -9,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.statusConnected,
  },
  label: {
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 0,
  },
  activeIndicator: {
    position: "absolute",
    top: -7,
    width: 30,
    height: 3,
    borderRadius: 1,
    backgroundColor: theme.colors.accentPrimary,
  },
  // Landscape side rail
  railContainer: {
    backgroundColor: theme.colors.bgBase,
    borderColor: theme.colors.borderSubtle,
    justifyContent: "center",
    alignItems: "center",
  },
  railTab: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginVertical: 4,
  },
  railTabActive: {
    backgroundColor: theme.colors.accentPrimary + "20",
  },
  railStatusDot: {
    position: "absolute",
    bottom: 4,
    right: 4,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.statusConnected,
  },
  railControls: {
    alignItems: "center",
    marginTop: 8,
  },
  railDivider: {
    width: 24,
    height: 1,
    backgroundColor: theme.colors.borderSubtle,
    marginBottom: 8,
  },
  railEditActive: {
    backgroundColor: theme.colors.accentPrimary,
  },
});
