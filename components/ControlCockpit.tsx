import { Ionicons } from '@expo/vector-icons';
import { TravelSpeedControl } from './TravelSpeed';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DEFAULTS } from '../constants/defaults';
import { theme } from '../constants/theme';
import { OMNI_BASE_FRAME, OMNI_MAP_FRAME, OMNI_ODOM_FRAME } from '../lib/frames';
import {
  AUTONOMY_MODE,
  AUTONOMY_PHASE,
  createMissionRequestEnvelope,
} from '../lib/autonomy-runtime';
import {
  DEFAULT_INSPECTION_COMMAND_TTL_SEC,
  cancelMission,
  dispatchMission,
  listRoutes,
  pauseMission,
  resumeMission,
} from '../lib/mission/api';
import {
  ACTIVE_MISSION_STATES,
  getRouteDispatchBlockReason,
  MISSION_STATE,
  type ControlResponse,
  type RouteDispatchBlockReason,
} from '../lib/mission/types';
import {
  ACTIVE_NAVIGATION_STATES,
  NAVIGATION_STATE,
  buildNavigationTargetPose,
  cancelNavigationGoal,
  submitNavigationGoal,
} from '../lib/navigation';
import {
  cancelActiveTouches,
  dispatchTouchEnd,
  dispatchTouchMove,
  dispatchTouchStart,
  setDeltaTransform,
} from '../lib/touch-dispatcher';
import { useLayoutStore } from '../stores/useLayoutStore';
import { useAutonomyRuntimeStore } from '../stores/useAutonomyRuntimeStore';
import { useMissionStore } from '../stores/useMissionStore';
import { useNavigationStore } from '../stores/useNavigationStore';
import { useRosStore } from '../stores/useRosStore';
import { useNavigationFeed } from '../hooks/useNavigationFeed';
import type { LayoutNode, SavedLayout, WidgetConfigField, WidgetNode } from '../types/layout';
import { cameraWidget } from '../widgets/camera';
import { mapWidget } from '../widgets/map';
import { pointCloud3DWidget } from '../widgets/pointcloud3d';
import { CameraFeed } from './CameraFeed';
import { EmergencyStop } from './EmergencyStop';
import { Joystick } from './Joystick';
import { LayoutManager } from './LayoutManager';
import { WidgetSettings } from './WidgetSettings';
import { MapWidget, type MapGoalSelection } from '../widgets/map/MapWidget';
import { PointCloud3DWidget } from '../widgets/pointcloud3d/PointCloud3DWidget';

type Scene = 'video' | 'map';
type PendingMapGoal = MapGoalSelection & { assetIdentityKey: string };

function routeDispatchBlockText(
  reason: RouteDispatchBlockReason,
  zh: boolean,
): string {
  switch (reason) {
    case 'legacy_map_binding':
      return zh
        ? '旧路线缺少完整地图校验信息，请在当前已保存地图上重新录制。'
        : 'This legacy route has no exact map checksum. Re-record it on the saved map.';
    case 'unsupported_frame':
      return zh
        ? '旧路线使用了非标准坐标系，请重新录制后再巡检。'
        : 'This route uses a non-canonical frame. Re-record it before inspection.';
    case 'malformed_route':
      return zh
        ? '路线数据不完整，当前无法派发。'
        : 'The route data is incomplete and cannot be dispatched.';
  }
}

interface ControlCockpitProps {
  language: 'zh' | 'en';
  isDemo: boolean;
  onExit: () => void;
  onExitDemo: () => void;
  onOpenRobotActions: () => void;
}

function findWidget(node: LayoutNode | undefined, widgetType: string): WidgetNode | null {
  if (!node) return null;
  if (node.type === 'widget') return node.widgetType === widgetType ? node : null;
  return findWidget(node.children[0], widgetType) || findWidget(node.children[1], widgetType);
}

export interface LocatedWidget {
  layoutId: string;
  node: WidgetNode;
}

/**
 * 控制台会全屏复用布局中的部件配置。优先读取当前布局；当前布局没有该部件时，
 * 再选择第一个可用配置，并保留所属 layoutId，确保编辑结果能写回正确布局。
 */
export function preferredWidget(
  layouts: SavedLayout[],
  activeLayoutId: string,
  widgetType: string,
): LocatedWidget | null {
  const active = layouts.find((layout) => layout.id === activeLayoutId);
  const fromActive = findWidget(active?.tree, widgetType);
  if (active && fromActive) return { layoutId: active.id, node: fromActive };
  for (const layout of layouts) {
    const node = findWidget(layout.tree, widgetType);
    if (node) return { layoutId: layout.id, node };
  }
  return null;
}

function CockpitButton({
  icon,
  label,
  active = false,
  danger = false,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  active?: boolean;
  danger?: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.cockpitButton, active && styles.cockpitButtonActive, danger && styles.cockpitButtonDanger]}
      activeOpacity={0.72}
      onPress={onPress}
    >
      <Ionicons
        name={icon}
        size={21}
        color={danger ? theme.colors.statusError : active ? '#FFFFFF' : theme.colors.textPrimary}
      />
      <Text style={[styles.cockpitButtonText, danger && styles.cockpitButtonDangerText]} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function GoalNudgeButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={`目标坐标 ${label}`}
      style={styles.goalNudgeButton}
      activeOpacity={0.72}
      onPress={onPress}
    >
      <Text style={styles.goalNudgeButtonText}>{label}</Text>
    </TouchableOpacity>
  );
}

const missionStateLabel = (state: number, zh: boolean) => {
  switch (state) {
    case MISSION_STATE.PENDING: return zh ? '等待执行' : 'Pending';
    case MISSION_STATE.EXECUTING: return zh ? '巡检中' : 'Inspecting';
    case MISSION_STATE.PAUSED: return zh ? '已暂停' : 'Paused';
    case MISSION_STATE.SUCCEEDED: return zh ? '已完成' : 'Completed';
    case MISSION_STATE.CANCELED: return zh ? '已取消' : 'Canceled';
    case MISSION_STATE.FAILED: return zh ? '执行失败' : 'Failed';
    case MISSION_STATE.INTERRUPTED: return zh ? '已中断' : 'Interrupted';
    default: return zh ? '无任务' : 'No mission';
  }
};

const navigationStateLabel = (state: number, zh: boolean) => {
  switch (state) {
    case NAVIGATION_STATE.PREPARING: return zh ? '准备中' : 'Preparing';
    case NAVIGATION_STATE.PLANNING: return zh ? '规划中' : 'Planning';
    case NAVIGATION_STATE.EXECUTING: return zh ? '导航中' : 'Navigating';
    case NAVIGATION_STATE.CANCELING: return zh ? '取消中' : 'Canceling';
    case NAVIGATION_STATE.SUCCEEDED: return zh ? '已到达' : 'Arrived';
    case NAVIGATION_STATE.CANCELED: return zh ? '已取消' : 'Canceled';
    case NAVIGATION_STATE.FAILED: return zh ? '导航失败' : 'Failed';
    case NAVIGATION_STATE.INTERRUPTED: return zh ? '已中断' : 'Interrupted';
    default: return zh ? '等待目标' : 'Waiting for goal';
  }
};

export function ControlCockpit({
  language,
  isDemo,
  onExit,
  onExitDemo,
  onOpenRobotActions,
}: ControlCockpitProps) {
  const zh = language === 'zh';
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const status = useRosStore((state) => state.connection.status);
  const transport = useRosStore((state) => state.transport);
  const url = useRosStore((state) => state.connection.url);
  const layouts = useLayoutStore((state) => state.layouts);
  const activeLayoutId = useLayoutStore((state) => state.activeLayoutId);
  const editMode = useLayoutStore((state) => state.editMode);
  const setEditMode = useLayoutStore((state) => state.setEditMode);
  const updateWidgetConfigInLayout = useLayoutStore((state) => state.updateWidgetConfigInLayout);
  const [scene, setScene] = useState<Scene>('video');
  const [missionsOpen, setMissionsOpen] = useState(false);
  const [pendingMapGoal, setPendingMapGoal] = useState<PendingMapGoal | null>(null);

  const routes = useMissionStore((state) => state.routes);
  const routesLoaded = useMissionStore((state) => state.routesLoaded);
  const selectedRouteId = useMissionStore((state) => state.selectedRouteId);
  const mission = useMissionStore((state) => state.status);
  const robotStrip = useMissionStore((state) => state.robotStrip);
  const missionStatusStale = useMissionStore((state) => state.missionStatusStale);
  const robotStateStale = useMissionStore((state) => state.robotStateStale);
  const dispatching = useMissionStore((state) => state.dispatching);
  const controlling = useMissionStore((state) => state.controlling);
  const lastError = useMissionStore((state) => state.lastError);
  const runtime = useAutonomyRuntimeStore((state) => state.status);
  const runtimeStale = useAutonomyRuntimeStore((state) => state.stale);
  const navigation = useNavigationStore((state) => state.status);
  const navigationStale = useNavigationStore((state) => state.stale);
  const navigationSubmitting = useNavigationStore((state) => state.submitting);
  const navigationCanceling = useNavigationStore((state) => state.canceling);
  const navigationOperationId = useNavigationStore((state) => state.activeOperationId);
  const navigationError = useNavigationStore((state) => state.lastError);

  const connected = status === 'connected' && Boolean(transport);
  const missionConnected = connected && !isDemo;
  const missionState = mission?.state ?? MISSION_STATE.NONE;
  const missionActive = !missionStatusStale &&
    ACTIVE_MISSION_STATES.includes(missionState);
  const navigationReady = !runtimeStale && runtime?.mode === AUTONOMY_MODE.SINGLE_POINT_READY &&
    runtime.ready === true && runtime.phase === AUTONOMY_PHASE.READY;
  const navigationKnownActive = ACTIVE_NAVIGATION_STATES.includes(
    navigation?.state ?? NAVIGATION_STATE.IDLE,
  );
  const navigationActive = !navigationStale && navigationKnownActive;
  const navigationCancelable = navigationKnownActive && Boolean(navigationOperationId);
  const mapIdentityReady = navigationReady && Boolean(runtime?.map_id) &&
    (runtime?.map_version ?? 0) > 0 && Boolean(runtime?.map_checksum);
  const mapAssetIdentityKey = runtime?.manager_epoch && runtime.map_id &&
    runtime.map_version > 0 && runtime.map_checksum
    ? [
      runtime?.manager_epoch,
      runtime?.map_id,
      runtime?.map_version,
      runtime?.map_checksum,
    ].join('\u0000')
    : '';

  // 自主运行状态由应用根层持续订阅；导航目标状态只在控制台需要。
  useNavigationFeed(missionConnected);

  const cameraSelection = useMemo(
    () => preferredWidget(layouts, activeLayoutId, 'camera'),
    [activeLayoutId, layouts],
  );
  const cameraConfig = cameraSelection?.node.config ?? cameraWidget.defaultConfig;
  const cameraSettingsSchema = useMemo<WidgetConfigField[]>(() => [
    {
      key: 'source',
      label: zh ? '传输方式' : 'Transport',
      type: 'select',
      options: [
        { label: zh ? 'Foxglove 直连' : 'Foxglove direct', value: 'transport' },
        { label: zh ? 'MJPEG 服务' : 'MJPEG server', value: 'mjpeg' },
      ],
    },
    {
      key: 'topic',
      label: zh ? '视频话题' : 'Video topic',
      type: 'topic',
      topicMessageTypes: ['sensor_msgs/msg/CompressedImage', 'foxglove_msgs/msg/CompressedVideo'],
    },
    {
      key: 'mjpegPort',
      label: zh ? 'MJPEG 端口' : 'MJPEG port',
      type: 'number',
      visibleWhen: { key: 'source', value: 'mjpeg' },
    },
    {
      key: 'maxFps',
      label: zh ? '最大显示帧率' : 'Maximum display rate',
      type: 'slider',
      min: 1,
      max: 30,
      step: 1,
      unit: 'fps',
      visibleWhen: { key: 'source', value: 'transport' },
    },
  ], [zh]);
  const mapSelection = useMemo(
    () => preferredWidget(layouts, activeLayoutId, 'map'),
    [activeLayoutId, layouts],
  );
  const mapConfig = useMemo(
    () => ({
      ...mapWidget.defaultConfig,
      ...(mapSelection?.node.config ?? {}),
      // 产品导航目标固定在 omni_tf_manager 的 canonical TF 树；主控制台
      // 不允许历史布局用 map/base_link 覆盖安全默认值。
      mapFrame: OMNI_MAP_FRAME,
      odomFrame: OMNI_ODOM_FRAME,
      robotFrame: OMNI_BASE_FRAME,
    }),
    [mapSelection],
  );
  const pointCloudSelection = useMemo(
    () => preferredWidget(layouts, activeLayoutId, 'pointcloud3d'),
    [activeLayoutId, layouts],
  );
  const pointCloudConfig = useMemo(
    () => ({
      ...pointCloud3DWidget.defaultConfig,
      ...(pointCloudSelection?.node.config ?? {}),
      mapFrame: OMNI_MAP_FRAME,
      robotFrame: OMNI_BASE_FRAME,
    }),
    [pointCloudSelection],
  );
  const usePointCloudScene = pointCloudSelection?.layoutId === activeLayoutId &&
    mapSelection?.layoutId !== activeLayoutId;
  const mapSettingsSchema = useMemo(
    () => (mapWidget.configSchema ?? []).filter(
      (field) => !['mapFrame', 'odomFrame', 'robotFrame'].includes(field.key),
    ),
    [],
  );
  const pointCloudSettingsSchema = useMemo(
    () => (pointCloud3DWidget.configSchema ?? []).filter(
      (field) => !['mapFrame', 'robotFrame'].includes(field.key),
    ),
    [],
  );
  const joystickConfig = useMemo(
    () => ({
      topic: DEFAULTS.cmdVelTopic,
      useTwistStamped: DEFAULTS.cmdVelUseTwistStamped,
      maxLinearVel: DEFAULTS.maxLinearVel,
      maxAngularVel: DEFAULTS.maxAngularVel,
      requireLocoMode: true,
      ...(preferredWidget(layouts, activeLayoutId, 'joystick')?.node.config ?? {}),
      frameId: OMNI_BASE_FRAME,
      overlayMode: true,
    }),
    [activeLayoutId, layouts],
  );

  useEffect(() => {
    setDeltaTransform((dx, dy) => ({ dx, dy }));
    return () => {
      setDeltaTransform((dx, dy) => ({ dx, dy }));
      // 离开控制页时不能把编辑态遗留给下一次会话。
      useLayoutStore.getState().setEditMode(false);
    };
  }, []);

  const refreshRoutes = useCallback(() => {
    if (!transport || !missionConnected) return;
    useMissionStore.getState().beginRoutesRefresh();
    useMissionStore.getState().setError(null);
    listRoutes(transport)
      .then((items) => useMissionStore.getState().setRoutes(items))
      .catch((error: any) => {
        // 拉取失败时结束加载态，并继续保持“空目录”这一失败关闭状态。
        useMissionStore.getState().setRoutes([]);
        useMissionStore.getState().setError(error?.message || String(error));
      });
  }, [missionConnected, transport]);

  useEffect(() => {
    if (missionsOpen && missionConnected) refreshRoutes();
  }, [missionConnected, missionsOpen, refreshRoutes]);

  const openInspectionPanel = useCallback(() => {
    useMissionStore.getState().setError(null);
    setMissionsOpen(true);
  }, []);

  const dispatchSelectedRoute = useCallback(() => {
    if (!transport || !selectedRouteId) return;
    const store = useMissionStore.getState();
    const selectedRoute = routes.find((route) => route.routeId === selectedRouteId);
    if (!selectedRoute) {
      store.setError(zh ? '路线不存在，请刷新后重试。' : 'Route not found. Refresh and try again.');
      return;
    }
    const routeBlockReason = getRouteDispatchBlockReason(selectedRoute);
    if (routeBlockReason) {
      store.setError(routeDispatchBlockText(routeBlockReason, zh));
      return;
    }
    if (store.robotStateStale || !store.robotStrip) {
      store.setError(zh ? '尚未收到机器人安全状态，暂不能下发巡检。' : 'Robot safety state is unavailable.');
      return;
    }
    if (store.missionStatusStale) {
      store.setError(zh ? 'Mission Manager 状态已过期，暂不能下发巡检。' : 'Mission Manager state is stale.');
      return;
    }
    if (store.status && ACTIVE_MISSION_STATES.includes(store.status.state)) {
      store.setError(zh ? '已有任务正在执行，请先完成或取消当前任务。' : 'Finish or cancel the active mission first.');
      return;
    }
    if (store.robotStrip.estop_latched) {
      store.setError(zh ? '急停已锁定，复位后才能下发巡检。' : 'Reset the latched E-stop before dispatch.');
      return;
    }
    Alert.alert(
      zh ? '开始巡检任务？' : 'Start inspection mission?',
      zh ? `将派发路线「${selectedRouteId}」，机器人会进入自主巡检。` : `Dispatch route “${selectedRouteId}” for autonomous inspection.`,
      [
        { text: zh ? '取消' : 'Cancel', style: 'cancel' },
        {
          text: zh ? '确认开始' : 'Start',
          onPress: async () => {
            const store = useMissionStore.getState();
            // 二次确认弹窗可能停留数秒；真正发送前必须再评估最新安全快照。
            if (store.robotStateStale || !store.robotStrip) {
              store.setError(zh ? '机器人状态已过期，本次派发已取消。' : 'Robot state became stale; dispatch was canceled.');
              return;
            }
            if (store.missionStatusStale) {
              store.setError(zh ? 'Mission Manager 状态已过期，本次派发已取消。' : 'Mission state became stale; dispatch was canceled.');
              return;
            }
            if (store.status && ACTIVE_MISSION_STATES.includes(store.status.state)) {
              store.setError(zh ? '已有任务开始执行，本次派发已取消。' : 'Another mission became active; dispatch was canceled.');
              return;
            }
            if (store.robotStrip.estop_latched) {
              store.setError(zh ? '急停已锁定，本次派发已取消。' : 'E-stop is latched; dispatch was canceled.');
              return;
            }
            // 路线目录也可能在确认期间刷新。必须使用当前 Store 中仍有效的
            // 资产身份，绝不能发送弹窗打开前捕获的旧 map/checksum。
            const currentRoute = store.routes.find(
              (route) => route.routeId === selectedRouteId,
            );
            if (!currentRoute) {
              store.setError(zh ? '路线目录已变化，本次派发已取消。' : 'The route catalog changed; dispatch was canceled.');
              return;
            }
            const currentRouteBlock = getRouteDispatchBlockReason(currentRoute);
            if (currentRouteBlock) {
              store.setError(routeDispatchBlockText(currentRouteBlock, zh));
              return;
            }
            const pending = store.pendingDispatch?.routeId === selectedRouteId
              ? store.pendingDispatch
              : {
                ...createMissionRequestEnvelope(
                  'inspection',
                  DEFAULT_INSPECTION_COMMAND_TTL_SEC,
                ),
                routeId: selectedRouteId,
              };
            store.setPendingDispatch(pending);
            store.setDispatching(true);
            store.setError(null);
            try {
              const response = await dispatchMission(transport, {
                routeId: selectedRouteId,
                requestId: pending.requestId,
                sequence: pending.sequence,
                source: pending.source,
                requestedAt: pending.requestedAt,
                deadline: pending.deadline,
                mapId: currentRoute.mapId,
                mapVersion: currentRoute.mapVersion,
                mapChecksum: currentRoute.mapChecksum,
                routeChecksum: currentRoute.routeChecksum,
              });
              if (response.accepted) {
                store.setPendingDispatch(null);
                setMissionsOpen(false);
              } else {
                store.setError(response.reason_text || (zh ? '任务管理器拒绝了请求' : 'Mission Manager rejected the request'));
              }
            } catch (error: any) {
              store.setError(error?.message || String(error));
            } finally {
              useMissionStore.getState().setDispatching(false);
            }
          },
        },
      ],
    );
  }, [routes, selectedRouteId, transport, zh]);

  const selectedRoute = routes.find((route) => route.routeId === selectedRouteId);
  const selectedRouteBlocked = selectedRoute
    ? getRouteDispatchBlockReason(selectedRoute) !== null
    : false;
  const inspectionDispatchBlocked = !selectedRouteId || selectedRouteBlocked ||
    missionStatusStale || robotStateStale || !robotStrip ||
    robotStrip.estop_latched || missionActive || dispatching;

  const runMissionControl = useCallback(async (call: (missionId?: string) => Promise<ControlResponse>) => {
    const store = useMissionStore.getState();
    store.setControlling(true);
    store.setError(null);
    try {
      const response = await call(mission?.mission_id || undefined);
      if (!response.accepted) store.setError(response.reason_text || (zh ? '任务控制请求被拒绝' : 'Mission control request rejected'));
    } catch (error: any) {
      store.setError(error?.message || String(error));
    } finally {
      useMissionStore.getState().setControlling(false);
    }
  }, [mission?.mission_id, zh]);

  const confirmCancelMission = useCallback(() => {
    if (!transport) return;
    Alert.alert(
      zh ? '停止巡检任务？' : 'Stop inspection mission?',
      zh ? '机器人将取消当前任务并停止自主巡检。' : 'The robot will cancel the active autonomous inspection.',
      [
        { text: zh ? '返回' : 'Back', style: 'cancel' },
        { text: zh ? '停止任务' : 'Stop mission', style: 'destructive', onPress: () => void runMissionControl((mid) => cancelMission(transport, mid)) },
      ],
    );
  }, [runMissionControl, transport, zh]);

  const submitMapGoal = useCallback(async (goal: MapGoalSelection) => {
    const snapshot = useAutonomyRuntimeStore.getState();
    const current = snapshot.status;
    const navigationSnapshot = useNavigationStore.getState();
    const currentMissionState = useMissionStore.getState().status?.state ?? MISSION_STATE.NONE;
    if (!transport || snapshot.stale || !current ||
        current.mode !== AUTONOMY_MODE.SINGLE_POINT_READY || !current.ready ||
        current.phase !== AUTONOMY_PHASE.READY || !current.map_id ||
        current.map_version <= 0 || !current.map_checksum || navigationSnapshot.stale ||
        ACTIVE_NAVIGATION_STATES.includes(
          navigationSnapshot.status?.state ?? NAVIGATION_STATE.IDLE,
        ) || ACTIVE_MISSION_STATES.includes(currentMissionState)) {
      navigationSnapshot.setPendingSubmit(null);
      setPendingMapGoal(null);
      Alert.alert(
        zh ? '导航不可用' : 'Navigation unavailable',
        zh ? '导航状态、运行时或地图身份已变化，请重新同步后选择目标。' : 'Navigation status, runtime, or map identity changed. Resync before selecting a goal.',
      );
      return;
    }
    if (navigationSnapshot.submitting || navigationSnapshot.canceling) return;
    const targetPose = buildNavigationTargetPose(
      OMNI_MAP_FRAME,
      goal.x,
      goal.y,
    );
    const retainedRequest = navigationSnapshot.pendingSubmit;
    const retainedPosition = retainedRequest?.targetPose.pose.position;
    const canRetryIdempotently = retainedRequest !== null &&
      retainedRequest.managerEpoch === current.manager_epoch &&
      retainedRequest.mapId === current.map_id &&
      retainedRequest.mapVersion === current.map_version &&
      retainedRequest.mapChecksum === current.map_checksum &&
      retainedRequest.targetPose.header.frame_id === targetPose.header.frame_id &&
      retainedPosition?.x === goal.x && retainedPosition?.y === goal.y;
    const request = canRetryIdempotently
      ? retainedRequest
      : {
        ...createMissionRequestEnvelope('nav-goal', 10 * 60),
        managerEpoch: current.manager_epoch,
        mapId: current.map_id,
        mapVersion: current.map_version,
        mapChecksum: current.map_checksum,
        targetPose,
        useFinalYaw: false,
        speedScale: 0,
      };
    navigationSnapshot.setPendingSubmit(request);
    if (!useNavigationStore.getState().beginSubmit()) return;
    try {
      const response = await submitNavigationGoal(transport, {
        mapId: request.mapId,
        mapVersion: request.mapVersion,
        mapChecksum: request.mapChecksum,
        targetPose: request.targetPose,
        requestId: request.requestId,
        sequence: request.sequence,
        source: request.source,
        requestedAt: request.requestedAt,
        deadline: request.deadline,
        useFinalYaw: request.useFinalYaw,
        speedScale: request.speedScale,
      });
      useNavigationStore.getState().completeSubmit(response);
      if (response.accepted) {
        // service 已返回 operation identity 后立即关闭草稿编辑器，禁止在
        // NavigationStatus 首帧到达前重复点击造成并发目标。
        setPendingMapGoal(null);
      } else {
        setPendingMapGoal(null);
        Alert.alert(
          zh ? '目标下发失败' : 'Goal rejected',
          response.reason_text || (zh ? '任务管理器拒绝了导航目标。' : 'Mission Manager rejected the navigation goal.'),
        );
      }
    } catch (error: any) {
      const message = error?.message || String(error);
      // The service may have accepted the request before the response was lost.
      // Keep both draft and envelope so an explicit retry uses the same identity.
      useNavigationStore.getState().failCommand(message);
      Alert.alert(zh ? '目标下发失败' : 'Goal failed', message);
    }
  }, [transport, zh]);

  const onMapGoalSelected = useCallback((goal: MapGoalSelection) => {
    if (!runtime) return;
    if (goal.frameId.replace(/^\//, '') !== OMNI_MAP_FRAME) {
      Alert.alert(
        zh ? '目标坐标系不可用' : 'Goal frame unavailable',
        zh
          ? `只能在 ${OMNI_MAP_FRAME} 中选择导航目标，请等待规范地图数据。`
          : `Navigation goals must be selected in ${OMNI_MAP_FRAME}. Wait for canonical map data.`,
      );
      return;
    }
    // 先保留为可编辑草稿，用户微调并确认后才调用 Mission typed service。
    useNavigationStore.getState().setPendingSubmit(null);
    setPendingMapGoal({
      ...goal,
      frameId: OMNI_MAP_FRAME,
      assetIdentityKey: mapAssetIdentityKey,
    });
  }, [mapAssetIdentityKey, runtime, zh]);

  const nudgePendingGoal = useCallback((deltaX: number, deltaY: number) => {
    useNavigationStore.getState().setPendingSubmit(null);
    setPendingMapGoal((goal) => goal ? {
      ...goal,
      x: goal.x + deltaX,
      y: goal.y + deltaY,
      frameId: OMNI_MAP_FRAME,
    } : null);
  }, []);

  const confirmCancelNavigation = useCallback(() => {
    if (!transport || !navigationOperationId) return;
    Alert.alert(
      zh ? '取消导航？' : 'Cancel navigation?',
      zh ? '现在停止当前单点导航目标吗？' : 'Stop the current point-navigation goal?',
      [
        { text: zh ? '返回' : 'Back', style: 'cancel' },
        {
          text: zh ? '取消导航' : 'Cancel goal',
          style: 'destructive',
          onPress: async () => {
            if (!useNavigationStore.getState().beginCancel()) return;
            try {
              const response = await cancelNavigationGoal(transport, {
                targetOperationId: navigationOperationId,
              });
              useNavigationStore.getState().completeCancel(response);
              if (!response.accepted) {
                Alert.alert(
                  zh ? '取消失败' : 'Cancellation rejected',
                  response.reason_text || (zh ? '任务管理器拒绝了取消请求。' : 'Mission Manager rejected cancellation.'),
                );
              }
            } catch (error: any) {
              const message = error?.message || String(error);
              useNavigationStore.getState().failCommand(message);
              Alert.alert(zh ? '取消失败' : 'Cancellation failed', message);
            }
          },
        },
      ],
    );
  }, [navigationOperationId, transport, zh]);

  useEffect(() => {
    if (!runtimeStale && !navigationReady) {
      setPendingMapGoal(null);
      useNavigationStore.getState().setPendingSubmit(null);
    }
  }, [navigationReady, runtimeStale]);

  useEffect(() => {
    setPendingMapGoal((goal) => {
      if (!goal || goal.assetIdentityKey === mapAssetIdentityKey) return goal;
      useNavigationStore.getState().setPendingSubmit(null);
      return null;
    });
  }, [mapAssetIdentityKey]);

  useEffect(() => {
    if (pendingMapGoal) cancelActiveTouches();
  }, [pendingMapGoal]);

  useEffect(() => {
    if (pendingMapGoal && navigationOperationId &&
        navigation?.operation_id === navigationOperationId) {
      setPendingMapGoal(null);
    }
  }, [navigation?.operation_id, navigationOperationId, pendingMapGoal]);

  const navigationGoalMarker = navigation?.target_pose?.pose?.position &&
    navigation.map_id === runtime?.map_id
    ? {
      x: navigation.target_pose.pose.position.x,
      y: navigation.target_pose.pose.position.y,
      frameId: navigation.target_pose.header.frame_id,
    }
    : null;
  const goalMarker = pendingMapGoal ?? navigationGoalMarker;

  return (
    <View
      style={styles.root}
      onTouchStart={(event) => {
        if (!pendingMapGoal) dispatchTouchStart([...event.nativeEvent.changedTouches]);
      }}
      onTouchMove={(event) => {
        if (!pendingMapGoal) dispatchTouchMove([...event.nativeEvent.changedTouches]);
      }}
      onTouchEnd={(event) => {
        if (!pendingMapGoal) dispatchTouchEnd([...event.nativeEvent.changedTouches]);
      }}
      onTouchCancel={(event) => {
        if (!pendingMapGoal) dispatchTouchEnd([...event.nativeEvent.changedTouches]);
      }}
    >
      <View pointerEvents={scene === 'map' ? 'box-none' : 'none'} style={StyleSheet.absoluteFill}>
        {connected ? (
          scene === 'video' ? (
            <CameraFeed config={cameraConfig} width={width} height={height} />
          ) : (
            usePointCloudScene ? (
              <PointCloud3DWidget
                config={pointCloudConfig}
                width={width}
                height={height}
                assetIdentityKey={mapAssetIdentityKey}
                goalSelectionEnabled={mapIdentityReady && !navigationStale && !navigationActive &&
                  !navigationSubmitting && !navigationOperationId && !missionActive}
                goalMarker={goalMarker}
                onGoalSelected={onMapGoalSelected}
              />
            ) : (
              <MapWidget
                config={mapConfig}
                width={width}
                height={height}
                assetIdentityKey={mapAssetIdentityKey}
                goalSelectionEnabled={mapIdentityReady && !navigationStale && !navigationActive &&
                  !navigationSubmitting && !navigationOperationId && !missionActive}
                goalMarker={goalMarker}
                onGoalSelected={onMapGoalSelected}
              />
            )
          )
        ) : (
          <View style={styles.offlineBackground}>
            <Ionicons name="videocam-off-outline" size={58} color={theme.colors.textMuted} />
            <Text style={styles.offlineTitle}>{zh ? '机器人未连接' : 'Robot disconnected'}</Text>
            <Text style={styles.offlineMessage}>{zh ? '退出控制页并前往设备页建立连接' : 'Exit control and connect from the Devices tab'}</Text>
          </View>
        )}
        <View pointerEvents="none" style={styles.sceneShadeTop} />
        <View pointerEvents="none" style={styles.sceneShadeBottom} />
        {scene === 'video' && connected ? <View style={styles.reticle}><View style={styles.reticleH} /><View style={styles.reticleV} /></View> : null}
      </View>

      {connected ? (
        <Joystick config={joystickConfig} width={width} height={height} />
      ) : null}

      <View pointerEvents="box-none" style={[styles.topBar, { paddingTop: Math.max(8, insets.top), paddingLeft: Math.max(10, insets.left + 8), paddingRight: Math.max(10, insets.right + 8) }]}>
        <View style={styles.topGroup}>
          <CockpitButton icon="arrow-back" label={zh ? '退出控制' : 'Exit'} onPress={onExit} />
          <View style={styles.connectionPill}>
            <View style={[styles.connectionDot, { backgroundColor: connected ? theme.colors.statusConnected : theme.colors.statusError }]} />
            <View>
              <Text style={styles.connectionLabel}>{connected ? (zh ? '已连接' : 'Connected') : (zh ? '未连接' : 'Offline')}</Text>
              <Text style={styles.connectionUrl} numberOfLines={1}>{isDemo ? (zh ? '演示模式' : 'Demo mode') : (url || '—')}</Text>
            </View>
          </View>
        </View>

        <View style={styles.sceneSwitch}>
          <TouchableOpacity style={[styles.sceneSwitchItem, scene === 'video' && styles.sceneSwitchItemActive]} onPress={() => setScene('video')}>
            <Ionicons name="videocam-outline" size={17} color={scene === 'video' ? '#FFFFFF' : theme.colors.textSecondary} />
            <Text style={[styles.sceneSwitchText, scene === 'video' && styles.sceneSwitchTextActive]}>{zh ? '视频' : 'Video'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.sceneSwitchItem, scene === 'map' && styles.sceneSwitchItemActive]} onPress={() => setScene('map')}>
            <Ionicons name="map-outline" size={17} color={scene === 'map' ? '#FFFFFF' : theme.colors.textSecondary} />
            <Text style={[styles.sceneSwitchText, scene === 'map' && styles.sceneSwitchTextActive]}>
              {usePointCloudScene ? (zh ? '点云' : 'Point cloud') : (zh ? '地图' : 'Map')}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.topGroup}>
          <EmergencyStop />
        </View>
      </View>

      <View pointerEvents="box-none" style={[styles.rightDock, { right: Math.max(12, insets.right + 10) }]}>
        <CockpitButton
          icon="settings-outline"
          label={scene === 'video'
            ? (zh ? '视频设置' : 'Video settings')
            : usePointCloudScene
              ? (zh ? '点云设置' : 'Point-cloud settings')
              : (zh ? '地图设置' : 'Map settings')}
          active={editMode}
          onPress={() => setEditMode(true)}
        />
        {navigationReady || navigationCancelable ? (
          <CockpitButton
            icon={navigationCancelable ? 'close-circle-outline' : 'locate-outline'}
            label={navigationCancelable
              ? (navigationCanceling ? (zh ? '取消中' : 'Canceling') : (zh ? '取消导航' : 'Cancel navigation'))
              : navigationStale
                ? (zh ? '同步导航状态' : 'Syncing navigation')
                : (zh ? '长按选点' : 'Long-press goal')}
            active={scene === 'map' || navigationCancelable}
            danger={navigationCancelable}
            onPress={navigationCancelable ? confirmCancelNavigation : () => setScene('map')}
          />
        ) : null}
        <CockpitButton
          icon="navigate-circle-outline"
          label={missionActive ? missionStateLabel(missionState, zh) : (zh ? '巡检任务' : 'Inspection')}
          active={missionActive}
          onPress={openInspectionPanel}
        />
        <CockpitButton icon="options-outline" label={zh ? '机器人动作' : 'Actions'} onPress={onOpenRobotActions} />
        <TravelSpeedControl />
      </View>

      {pendingMapGoal && scene === 'map' && !navigationActive ? (
        <View
          accessibilityLabel={zh ? '导航目标编辑器' : 'Navigation goal editor'}
          style={[styles.goalEditor, { bottom: Math.max(66, insets.bottom + 58) }]}
        >
          <View style={styles.goalEditorCopy}>
            <Text style={styles.goalEditorTitle}>
              {zh ? '确认导航目标' : 'Confirm navigation goal'}
            </Text>
            <Text style={styles.goalEditorCoordinates}>
              X {pendingMapGoal.x.toFixed(2)} m · Y {pendingMapGoal.y.toFixed(2)} m
            </Text>
          </View>
          <View style={styles.goalNudgeRow}>
            <GoalNudgeButton label="X−" onPress={() => nudgePendingGoal(-0.25, 0)} />
            <GoalNudgeButton label="X+" onPress={() => nudgePendingGoal(0.25, 0)} />
            <GoalNudgeButton label="Y−" onPress={() => nudgePendingGoal(0, -0.25)} />
            <GoalNudgeButton label="Y+" onPress={() => nudgePendingGoal(0, 0.25)} />
          </View>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={zh ? '取消目标' : 'Cancel goal draft'}
            style={styles.goalEditorCancel}
            onPress={() => {
              useNavigationStore.getState().setPendingSubmit(null);
              setPendingMapGoal(null);
            }}
          >
            <Text style={styles.goalEditorCancelText}>{zh ? '取消' : 'Cancel'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={zh ? '开始导航' : 'Start navigation'}
            style={[styles.goalEditorSubmit, navigationSubmitting && styles.goalEditorSubmitDisabled]}
            disabled={navigationSubmitting}
            onPress={() => void submitMapGoal(pendingMapGoal)}
          >
            <Ionicons name="navigate" size={16} color="#061014" />
            <Text style={styles.goalEditorSubmitText}>
              {navigationSubmitting ? (zh ? '下发中…' : 'Sending…') : (zh ? '开始导航' : 'Navigate')}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <View pointerEvents="none" style={styles.bottomCenterStatus}>
        <Text style={styles.bottomCenterTitle}>
          {scene === 'video'
            ? (zh ? '实时画面' : 'LIVE VIEW')
            : usePointCloudScene
              ? (zh ? '三维地图' : '3D MAP')
              : (zh ? '实时地图' : 'LIVE MAP')}
        </Text>
        <Text style={styles.bottomCenterValue}>
          {missionActive
            ? `${missionStateLabel(missionState, zh)} · ${Math.round(Math.max(0, Math.min(1, mission?.progress || 0)) * 100)}%`
            : navigation && !navigationStale && navigation.state !== NAVIGATION_STATE.IDLE
              ? `${navigationStateLabel(navigation.state, zh)} · ${Math.max(0, navigation.remaining_distance_m).toFixed(1)} m`
              : navigationKnownActive && navigationStale
                ? (zh ? '导航状态同步中，可取消当前目标' : 'Navigation status is stale; the current goal can still be canceled')
              : navigationError
                ? navigationError
                : navigationReady && scene === 'map'
                  ? (zh ? '长按地图选择目标，可用 X/Y 按钮微调' : 'Long-press to select; use X/Y buttons to adjust')
            : (zh ? '左摇杆 X / Y · 右摇杆 YAW' : 'Left X / Y · Right YAW')}
        </Text>
      </View>

      {isDemo ? (
        <TouchableOpacity style={[styles.demoPill, { left: Math.max(12, insets.left + 10) }]} onPress={onExitDemo}>
          <Ionicons name="flask-outline" size={15} color={theme.colors.statusConnecting} />
          <Text style={styles.demoPillText}>{zh ? '演示模式：不会发送真实指令' : 'Demo: no hardware commands'}</Text>
          <Ionicons name="close" size={15} color={theme.colors.statusConnecting} />
        </TouchableOpacity>
      ) : null}

      {/* 让横屏侧栏的“布局管理”入口在全屏控制台中也真正可用。 */}
      <View style={styles.hiddenLayoutManager} pointerEvents="box-none">
        <LayoutManager />
      </View>

      <WidgetSettings
        visible={editMode}
        widgetName={scene === 'video'
          ? (zh ? '视频画面' : 'Video')
          : usePointCloudScene
            ? (zh ? '三维点云' : '3D point cloud')
            : (zh ? '二维地图' : '2D map')}
        language={language}
        description={scene === 'video'
          ? (zh ? '选择机器人视频话题；保存后立即应用到控制页。' : 'Choose the robot video topic. Changes apply immediately after saving.')
          : (zh ? `可调整数据话题；导航 frame 固定为 ${OMNI_MAP_FRAME}/${OMNI_BASE_FRAME}。` : `Adjust data topics; navigation frames stay locked to ${OMNI_MAP_FRAME}/${OMNI_BASE_FRAME}.`)}
        configSchema={scene === 'video'
          ? cameraSettingsSchema
          : usePointCloudScene
            ? pointCloudSettingsSchema
            : mapSettingsSchema}
        config={scene === 'video'
          ? cameraConfig
          : usePointCloudScene
            ? pointCloudConfig
            : mapConfig}
        recommendedConfig={scene === 'video'
          ? {
            topic: DEFAULTS.cameraTopic,
            source: 'transport',
            maxFps: 10,
            mjpegPort: DEFAULTS.mjpegPort,
          }
          : usePointCloudScene
            ? pointCloud3DWidget.defaultConfig
            : mapWidget.defaultConfig}
        recommendedDescription={scene === 'video'
          ? undefined
          : usePointCloudScene
            ? (zh ? '恢复 Matrix 全局点云话题和规范 TF。' : 'Restore the Matrix global cloud topic and canonical TF.')
            : (zh ? '恢复地图、激光和规范 TF 默认配置。' : 'Restore map, scan, and canonical TF defaults.')}
        onConfigChange={(nextConfig) => {
          const selection = scene === 'video'
            ? cameraSelection
            : usePointCloudScene
              ? pointCloudSelection
              : mapSelection;
          if (!selection) return;
          updateWidgetConfigInLayout(selection.layoutId, selection.node.id, nextConfig);
        }}
        onClose={() => setEditMode(false)}
      />

      <Modal visible={missionsOpen} transparent animationType="fade" onRequestClose={() => setMissionsOpen(false)}>
        <View style={styles.modalOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setMissionsOpen(false)} />
          <View style={[styles.missionPanel, { paddingRight: Math.max(18, insets.right + 16) }]}>
            <View style={styles.panelHeader}>
              <View>
                <Text style={styles.panelTitle}>{zh ? '巡检任务' : 'Inspection mission'}</Text>
                <Text style={styles.panelSubtitle}>{zh ? '选择路线并交由任务管理器统一调度' : 'Select a route and let Mission Manager prepare the runtime'}</Text>
              </View>
              <TouchableOpacity style={styles.panelClose} onPress={() => setMissionsOpen(false)}>
                <Ionicons name="close" size={22} color={theme.colors.textPrimary} />
              </TouchableOpacity>
            </View>

            {!missionConnected ? (
              <View style={styles.panelEmpty}>
                <Ionicons name="cloud-offline-outline" size={34} color={theme.colors.textMuted} />
                <Text style={styles.panelEmptyText}>{isDemo ? (zh ? '演示模式不下发巡检任务' : 'Demo mode cannot dispatch missions') : (zh ? '请先连接真实机器人' : 'Connect a real robot first')}</Text>
              </View>
            ) : missionActive ? (
              <View style={styles.activeMissionCard}>
                <Text style={styles.activeMissionEyebrow}>{zh ? '当前任务' : 'ACTIVE MISSION'}</Text>
                <TravelSpeedControl />
                <Text style={styles.activeMissionRoute}>{mission?.route_id || mission?.mission_id}</Text>
                <Text style={styles.activeMissionState}>{missionStateLabel(missionState, zh)} · {Math.round(Math.max(0, Math.min(1, mission?.progress || 0)) * 100)}%</Text>
                <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${Math.max(0, Math.min(1, mission?.progress || 0)) * 100}%` }]} /></View>
                <View style={styles.missionControlRow}>
                  {missionState === MISSION_STATE.PAUSED ? (
                    <CockpitButton icon="play" label={zh ? '继续任务' : 'Resume'} onPress={() => transport && void runMissionControl((mid) => resumeMission(transport, mid))} />
                  ) : (
                    <CockpitButton icon="pause" label={zh ? '暂停任务' : 'Pause'} onPress={() => transport && void runMissionControl((mid) => pauseMission(transport, mid))} />
                  )}
                  <CockpitButton icon="stop-circle-outline" label={zh ? '停止任务' : 'Stop'} danger onPress={confirmCancelMission} />
                </View>
              </View>
            ) : (
              <>
                <View style={styles.routeSectionHeader}>
                  <Text style={styles.routeSectionTitle}>{zh ? '可用巡检路线' : 'Available routes'}</Text>
                  <TouchableOpacity style={styles.refreshButton} onPress={refreshRoutes}>
                    <Ionicons name="refresh" size={17} color={theme.colors.accentPrimary} />
                    <Text style={styles.refreshText}>{zh ? '刷新' : 'Refresh'}</Text>
                  </TouchableOpacity>
                </View>
                <ScrollView style={styles.routesList} contentContainerStyle={styles.routesContent} showsVerticalScrollIndicator={false}>
                  {!routesLoaded ? <Text style={styles.routeEmpty}>{zh ? '正在读取路线…' : 'Loading routes…'}</Text> : null}
                  {routesLoaded && routes.length === 0 ? <Text style={styles.routeEmpty}>{zh ? '机器人上还没有可用巡检路线' : 'No inspection routes found on the robot'}</Text> : null}
                  {routesLoaded ? routes.map((route) => {
                    const blockReason = getRouteDispatchBlockReason(route);
                    const blocked = blockReason !== null;
                    const selected = !blocked && selectedRouteId === route.routeId;
                    return (
                      <TouchableOpacity key={route.routeId} accessibilityState={{ disabled: blocked, selected }} style={[styles.routeRow, selected && styles.routeRowSelected, blocked && styles.routeRowBlocked]} onPress={() => {
                        if (blockReason) {
                          useMissionStore.getState().setError(routeDispatchBlockText(blockReason, zh));
                          return;
                        }
                        useMissionStore.getState().selectRoute(selected ? null : route.routeId);
                      }}>
                        <View style={[styles.routeIcon, selected && styles.routeIconSelected]}><Ionicons name={blocked ? 'warning-outline' : 'git-branch-outline'} size={20} color={blocked ? theme.colors.statusConnecting : selected ? theme.colors.accentPrimary : theme.colors.textSecondary} /></View>
                        <View style={styles.routeCopy}>
                          <Text style={[styles.routeName, blocked && styles.routeNameBlocked]}>{route.routeId}</Text>
                          <Text style={styles.routeMeta} numberOfLines={1}>
                            {route.mapId
                              ? `${zh ? '地图' : 'Map'}: ${route.mapId}${route.mapVersion ? ` · ${route.mapVersion.startsWith('v') ? route.mapVersion : `v${route.mapVersion}`}` : ''}`
                              : (zh ? '未绑定地图' : 'No map binding')}
                            {route.pointCount > 0 ? ` · ${route.pointCount}${zh ? '点' : ' pts'}` : ''}
                            {route.distanceM > 0 ? ` · ${route.distanceM.toFixed(1)} m` : ''}
                          </Text>
                          {blockReason ? <Text style={styles.routeBlockReason}>{routeDispatchBlockText(blockReason, zh)}</Text> : null}
                        </View>
                        <Ionicons name={selected ? 'checkmark-circle' : blocked ? 'alert-circle-outline' : 'ellipse-outline'} size={22} color={selected ? theme.colors.accentPrimary : blocked ? theme.colors.statusConnecting : theme.colors.borderDefault} />
                      </TouchableOpacity>
                    );
                  }) : null}
                </ScrollView>
                <TouchableOpacity disabled={inspectionDispatchBlocked} style={[styles.dispatchButton, inspectionDispatchBlocked && styles.dispatchButtonDisabled]} onPress={dispatchSelectedRoute}>
                  <Ionicons name={dispatching ? 'hourglass-outline' : 'send'} size={18} color="#061014" />
                  <Text style={styles.dispatchButtonText}>{dispatching ? (zh ? '正在下发…' : 'Dispatching…') : (zh ? '开始巡检任务' : 'Start inspection')}</Text>
                </TouchableOpacity>
                {robotStateStale || !robotStrip ? <Text style={styles.dispatchBlockReason}>{zh ? '等待机器人安全状态…' : 'Waiting for robot safety state…'}</Text> : null}
                {missionStatusStale ? <Text style={styles.dispatchBlockReason}>{zh ? '等待 Mission Manager 新心跳…' : 'Waiting for a fresh Mission Manager heartbeat…'}</Text> : null}
                {robotStrip?.estop_latched ? <Text style={styles.dispatchBlockReason}>{zh ? '急停已锁定，复位后才能开始巡检。' : 'Reset the latched E-stop before inspection.'}</Text> : null}
              </>
            )}
            {controlling ? <Text style={styles.panelNotice}>{zh ? '正在等待任务管理器响应…' : 'Waiting for Mission Manager…'}</Text> : null}
            {lastError ? <Text style={styles.panelError}>{lastError}</Text> : null}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#020607', overflow: 'hidden' },
  offlineBackground: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: '#061014' },
  offlineTitle: { color: theme.colors.textPrimary, fontSize: 19, fontWeight: '700' },
  offlineMessage: { color: theme.colors.textMuted, fontSize: 13 },
  sceneShadeTop: { position: 'absolute', top: 0, left: 0, right: 0, height: 92, backgroundColor: '#0206079A' },
  sceneShadeBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 150, backgroundColor: '#02060768' },
  reticle: { position: 'absolute', left: '50%', top: '50%', width: 42, height: 42, marginLeft: -21, marginTop: -21, borderRadius: 21, borderWidth: 1, borderColor: '#FFFFFF38' },
  reticleH: { position: 'absolute', width: 12, height: 1, backgroundColor: '#FFFFFF60', top: 20, left: 15 },
  reticleV: { position: 'absolute', width: 1, height: 12, backgroundColor: '#FFFFFF60', top: 15, left: 20 },
  topBar: { position: 'absolute', top: 0, left: 0, right: 0, minHeight: 66, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, paddingBottom: 8 },
  topGroup: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cockpitButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 13, borderRadius: 13, borderWidth: 1, borderColor: '#FFFFFF28', backgroundColor: '#071116CE' },
  cockpitButtonActive: { borderColor: theme.colors.accentPrimary + 'AA', backgroundColor: '#27515BDD' },
  cockpitButtonDanger: { borderColor: theme.colors.statusError + '99', backgroundColor: '#311519DD' },
  cockpitButtonText: { color: theme.colors.textPrimary, fontSize: 12, fontWeight: '700' },
  cockpitButtonDangerText: { color: theme.colors.statusError },
  connectionPill: { maxWidth: 230, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 12, borderRadius: 13, borderWidth: 1, borderColor: '#FFFFFF22', backgroundColor: '#071116CE' },
  connectionDot: { width: 8, height: 8, borderRadius: 4 },
  connectionLabel: { color: theme.colors.textPrimary, fontSize: 11, fontWeight: '700' },
  connectionUrl: { maxWidth: 170, color: theme.colors.textMuted, fontFamily: 'SpaceMono', fontSize: 8, marginTop: 1 },
  sceneSwitch: { flexDirection: 'row', padding: 3, borderRadius: 13, borderWidth: 1, borderColor: '#FFFFFF22', backgroundColor: '#071116D9' },
  sceneSwitchItem: { height: 38, minWidth: 82, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 13, borderRadius: 10 },
  sceneSwitchItemActive: { backgroundColor: '#FFFFFF18' },
  sceneSwitchText: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: '600' },
  sceneSwitchTextActive: { color: '#FFFFFF' },
  rightDock: { position: 'absolute', top: 92, flexDirection: 'row', gap: 9, alignItems: 'flex-start' },
  hiddenLayoutManager: { position: 'absolute', width: 0, height: 0, overflow: 'hidden' },
  goalEditor: { position: 'absolute', alignSelf: 'center', minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 14, borderWidth: 1, borderColor: theme.colors.accentPrimary + 'AA', backgroundColor: '#071116F2' },
  goalEditorCopy: { minWidth: 128, paddingHorizontal: 3 },
  goalEditorTitle: { color: theme.colors.textPrimary, fontSize: 11, fontWeight: '800' },
  goalEditorCoordinates: { color: theme.colors.accentPrimary, fontFamily: 'SpaceMono', fontSize: 9, marginTop: 3 },
  goalNudgeRow: { flexDirection: 'row', gap: 4 },
  goalNudgeButton: { minWidth: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 9, borderWidth: 1, borderColor: '#FFFFFF24', backgroundColor: '#FFFFFF0C' },
  goalNudgeButtonText: { color: theme.colors.textPrimary, fontFamily: 'SpaceMono', fontSize: 10, fontWeight: '700' },
  goalEditorCancel: { height: 36, justifyContent: 'center', paddingHorizontal: 10, borderRadius: 9, borderWidth: 1, borderColor: '#FFFFFF24' },
  goalEditorCancelText: { color: theme.colors.textSecondary, fontSize: 10, fontWeight: '700' },
  goalEditorSubmit: { height: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingHorizontal: 12, borderRadius: 9, backgroundColor: theme.colors.accentPrimary },
  goalEditorSubmitDisabled: { opacity: 0.45 },
  goalEditorSubmitText: { color: '#061014', fontSize: 10, fontWeight: '800' },
  bottomCenterStatus: { position: 'absolute', bottom: 15, left: '35%', right: '35%', minHeight: 41, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: '#FFFFFF18', backgroundColor: '#061014B8' },
  bottomCenterTitle: { color: theme.colors.textMuted, fontSize: 8, fontWeight: '700', letterSpacing: 1 },
  bottomCenterValue: { color: theme.colors.textValue, fontFamily: 'SpaceMono', fontSize: 9, marginTop: 2 },
  demoPill: { position: 'absolute', bottom: 15, flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 38, paddingHorizontal: 11, borderRadius: 11, backgroundColor: '#2D2214DD', borderWidth: 1, borderColor: theme.colors.statusConnecting + '55' },
  demoPillText: { color: theme.colors.statusConnecting, fontSize: 10, fontWeight: '600' },
  modalOverlay: { flex: 1, alignItems: 'flex-end', backgroundColor: '#00000070' },
  missionPanel: { width: 420, maxWidth: '64%', height: '100%', paddingLeft: 18, paddingTop: 18, paddingBottom: 18, backgroundColor: '#0A151BEF', borderLeftWidth: 1, borderLeftColor: theme.colors.borderDefault },
  panelHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 16, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: theme.colors.borderSubtle },
  panelTitle: { color: theme.colors.textPrimary, fontSize: 19, fontWeight: '700' },
  panelSubtitle: { color: theme.colors.textMuted, fontSize: 11, marginTop: 3 },
  panelClose: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: theme.colors.bgSurface },
  panelEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  panelEmptyText: { color: theme.colors.textMuted, fontSize: 13 },
  routeSectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 15, marginBottom: 8 },
  routeSectionTitle: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: '700' },
  refreshButton: { flexDirection: 'row', alignItems: 'center', gap: 5, padding: 7 },
  refreshText: { color: theme.colors.accentPrimary, fontSize: 11, fontWeight: '600' },
  routesList: { flex: 1 },
  routesContent: { paddingBottom: 10 },
  routeEmpty: { color: theme.colors.textMuted, fontSize: 12, textAlign: 'center', paddingVertical: 35 },
  routeRow: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 7, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.borderSubtle, backgroundColor: '#FFFFFF08' },
  routeRowSelected: { borderColor: theme.colors.accentPrimary + '99', backgroundColor: theme.colors.accentPrimaryMuted },
  routeRowBlocked: { opacity: 0.72 },
  routeIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.bgSurface },
  routeIconSelected: { backgroundColor: theme.colors.accentPrimaryMuted },
  routeCopy: { flex: 1, minWidth: 0 },
  routeName: { color: theme.colors.textValue, fontSize: 13, fontWeight: '700' },
  routeNameBlocked: { color: theme.colors.textSecondary },
  routeMeta: { color: theme.colors.textMuted, fontSize: 10, marginTop: 3 },
  routeBlockReason: { color: theme.colors.statusConnecting, fontSize: 10, lineHeight: 14, marginTop: 3 },
  dispatchButton: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 13, backgroundColor: theme.colors.accentPrimary },
  dispatchButtonDisabled: { opacity: 0.4 },
  dispatchButtonText: { color: '#061014', fontSize: 13, fontWeight: '800' },
  dispatchBlockReason: { color: theme.colors.textMuted, fontSize: 10, lineHeight: 14, textAlign: 'center' },
  activeMissionCard: { marginTop: 18, padding: 16, borderRadius: 14, borderWidth: 1, borderColor: theme.colors.accentPrimary + '66', backgroundColor: theme.colors.accentPrimaryMuted },
  activeMissionEyebrow: { color: theme.colors.accentPrimary, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  activeMissionRoute: { color: theme.colors.textPrimary, fontSize: 18, fontWeight: '700', marginTop: 8 },
  activeMissionState: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 4 },
  progressTrack: { height: 7, borderRadius: 4, backgroundColor: theme.colors.bgInset, overflow: 'hidden', marginVertical: 14 },
  progressFill: { height: '100%', backgroundColor: theme.colors.accentPrimary },
  missionControlRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  panelNotice: { color: theme.colors.statusConnecting, fontSize: 10, marginTop: 9 },
  panelError: { color: theme.colors.statusError, fontSize: 10, marginTop: 9 },
});
