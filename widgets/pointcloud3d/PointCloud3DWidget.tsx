import { Canvas, Points, vec } from '@shopify/react-native-skia';
import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { WidgetEmptyState } from '../../components/WidgetEmptyState';
import { theme } from '../../constants/theme';
import { useTranslation } from '../../lib/i18n';
import { useMappingStore } from '../../stores/useMappingStore';
import { useRosStore } from '../../stores/useRosStore';
import type { WidgetProps } from '../../types/layout';
import {
  AdaptiveVoxelAccumulator,
  parsePointCloud2,
  projectPointCloud,
  TfPositionTracker,
  type Point3D,
  type PointCloudPoint,
} from './transforms';

const HEIGHT_COLORS = ['#2563EB', '#06B6D4', '#22C55E', '#A3E635', '#FBBF24', '#EF4444'];
const MAX_RENDER_POINTS = 18000;
const RENDER_INTERVAL_MS = 400;
const DEFAULT_VIEW_METERS = 20;

interface CameraState {
  yaw: number;
  pitch: number;
  zoom: number;
}

function projectByHeight(
  points: PointCloudPoint[],
  width: number,
  height: number,
  camera: CameraState,
  target: Point3D,
  viewMeters: number,
) {
  const bins = HEIGHT_COLORS.map(() => [] as ReturnType<typeof vec>[]);
  if (points.length === 0 || width <= 0 || height <= 0) return bins;

  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
  }
  const projected = projectPointCloud(points, width, height, {
    ...camera,
    target,
    viewMeters,
  });
  const zRange = Math.max(0.01, maxZ - minZ);
  for (const point of projected) {
    const bin = Math.min(
      HEIGHT_COLORS.length - 1,
      Math.max(0, Math.floor(((point.z - minZ) / zRange) * HEIGHT_COLORS.length)),
    );
    bins[bin].push(vec(point.x, point.y));
  }
  return bins;
}

export function PointCloud3DWidget(props: Partial<WidgetProps>) {
  const transport = useRosStore((state) => state.transport);
  const connectionStatus = useRosStore((state) => state.connection.status);
  const mappingActive = useMappingStore((state) => state.active);
  const sessionId = useMappingStore((state) => state.sessionId);
  const topic = props?.config?.topic || '/cloud_registered';
  const mapFrame = String(props?.config?.mapFrame || 'map_frame').replace(/^\//, '');
  const robotFrame = String(props?.config?.robotFrame || 'lidar_frame').replace(/^\//, '');
  const odomTopic = props?.config?.odomTopic || '/Odometry';
  const viewMeters = Math.max(2, Number(props?.config?.viewMeters || DEFAULT_VIEW_METERS));
  const width = Math.max(1, props?.width || 300);
  const height = Math.max(1, props?.height || 300);
  const { t } = useTranslation();

  const accumulatorRef = useRef(new AdaptiveVoxelAccumulator(0.12, 60000));
  const tfTrackerRef = useRef(new TfPositionTracker());
  const robotPositionRef = useRef<Point3D>({ x: 0, y: 0, z: 0 });
  const hasTfPositionRef = useRef(false);
  const lastRenderRef = useRef(0);
  const frameCountRef = useRef(0);
  const [renderPoints, setRenderPoints] = useState<PointCloudPoint[]>([]);
  const [robotPosition, setRobotPosition] = useState<Point3D>({ x: 0, y: 0, z: 0 });
  const [stats, setStats] = useState({ frames: 0, points: 0, voxel: 0.12, frameId: 'map_frame' });
  const [camera, setCamera] = useState<CameraState>({ yaw: -0.7, pitch: 0.75, zoom: 1 });
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const orbitStartRef = useRef(camera);
  const zoomStartRef = useRef(1);

  const clearPreview = useCallback(() => {
    accumulatorRef.current.clear();
    frameCountRef.current = 0;
    setRenderPoints([]);
    tfTrackerRef.current.clear();
    robotPositionRef.current = { x: 0, y: 0, z: 0 };
    hasTfPositionRef.current = false;
    setRobotPosition({ x: 0, y: 0, z: 0 });
    setStats({ frames: 0, points: 0, voxel: 0.12, frameId: 'map_frame' });
  }, []);

  useEffect(() => clearPreview(), [sessionId, clearPreview]);

  useEffect(() => {
    if (!mappingActive || connectionStatus !== 'connected' || !transport) return;
    const subscription = transport.subscribe(topic, 'sensor_msgs/msg/PointCloud2', (message) => {
      const incoming = parsePointCloud2(message);
      if (incoming.length === 0) return;
      const accumulator = accumulatorRef.current;
      accumulator.add(incoming);
      frameCountRef.current += 1;
      const now = Date.now();
      if (now - lastRenderRef.current < RENDER_INTERVAL_MS) return;
      lastRenderRef.current = now;
      setRenderPoints(accumulator.snapshot(MAX_RENDER_POINTS));
      setRobotPosition(robotPositionRef.current);
      setStats({
        frames: frameCountRef.current,
        points: accumulator.pointCount,
        voxel: accumulator.voxelSize,
        frameId: String(message?.header?.frame_id || 'map_frame'),
      });
    }, 150);

    return () => {
      subscription.unsubscribe();
      const accumulator = accumulatorRef.current;
      setRenderPoints(accumulator.snapshot(MAX_RENDER_POINTS));
    };
  }, [mappingActive, connectionStatus, transport, topic]);

  useEffect(() => {
    if (!mappingActive || connectionStatus !== 'connected' || !transport) return;
    hasTfPositionRef.current = false;
    const cachedPosition = tfTrackerRef.current.lookupPosition(mapFrame, robotFrame);
    if (cachedPosition) {
      robotPositionRef.current = cachedPosition;
      hasTfPositionRef.current = true;
      setRobotPosition(cachedPosition);
    }
    const handleTf = (message: any) => {
      const tracker = tfTrackerRef.current;
      tracker.update(message);
      const position = tracker.lookupPosition(mapFrame, robotFrame);
      if (position) {
        robotPositionRef.current = position;
        hasTfPositionRef.current = true;
      }
    };
    const tfSub = transport.subscribe('/tf', 'tf2_msgs/msg/TFMessage', handleTf);
    const staticTfSub = transport.subscribe('/tf_static', 'tf2_msgs/msg/TFMessage', handleTf);
    const odomSub = transport.subscribe(odomTopic, 'nav_msgs/msg/Odometry', (message) => {
      if (hasTfPositionRef.current) return;
      const position = message?.pose?.pose?.position;
      const frame = String(message?.header?.frame_id || '').replace(/^\//, '');
      const childFrame = String(message?.child_frame_id || robotFrame).replace(/^\//, '');
      if (!position || !frame || !childFrame) return;
      tfTrackerRef.current.update({ transforms: [{
        header: { frame_id: frame },
        child_frame_id: childFrame,
        transform: {
          translation: position,
          rotation: message?.pose?.pose?.orientation,
        },
      }] });
      const resolved = tfTrackerRef.current.lookupPosition(mapFrame, childFrame);
      if (resolved) robotPositionRef.current = resolved;
    });
    return () => {
      tfSub.unsubscribe();
      staticTfSub.unsubscribe();
      odomSub.unsubscribe();
      hasTfPositionRef.current = false;
    };
  }, [mappingActive, connectionStatus, transport, mapFrame, robotFrame, odomTopic]);

  const beginOrbit = useCallback(() => {
    orbitStartRef.current = cameraRef.current;
  }, []);
  const updateOrbit = useCallback((translationX: number, translationY: number) => {
    const start = orbitStartRef.current;
    setCamera({
      ...start,
      yaw: start.yaw + translationX * 0.008,
      pitch: Math.max(0, Math.min(1.4, start.pitch - translationY * 0.006)),
    });
  }, []);
  const beginZoom = useCallback(() => {
    zoomStartRef.current = cameraRef.current.zoom;
  }, []);
  const updateZoom = useCallback((scale: number) => {
    setCamera((current) => ({
      ...current,
      zoom: Math.max(0.5, Math.min(8, zoomStartRef.current * scale)),
    }));
  }, []);

  const gesture = useMemo(() => Gesture.Simultaneous(
    Gesture.Pan()
      .onStart(() => runOnJS(beginOrbit)())
      .onUpdate((event) => runOnJS(updateOrbit)(event.translationX, event.translationY)),
    Gesture.Pinch()
      .onStart(() => runOnJS(beginZoom)())
      .onUpdate((event) => runOnJS(updateZoom)(event.scale)),
  ), [beginOrbit, updateOrbit, beginZoom, updateZoom]);

  const heightBins = useMemo(
    () => projectByHeight(renderPoints, width, height, camera, robotPosition, viewMeters),
    [renderPoints, width, height, camera, robotPosition, viewMeters],
  );

  if (!mappingActive && renderPoints.length === 0) {
    return (
      <WidgetEmptyState
        widgetType="pointcloud3d"
        topicName={topic}
        hint={t('pointCloud.waiting')}
      />
    );
  }

  return (
    <View style={styles.container}>
      <GestureDetector gesture={gesture}>
        <View style={{ width, height }}>
          <Canvas style={{ width, height }}>
            {heightBins.map((points, index) => points.length > 0 && (
              <Points
                key={HEIGHT_COLORS[index]}
                points={points}
                mode="points"
                color={HEIGHT_COLORS[index]}
                strokeWidth={1.6}
              />
            ))}
          </Canvas>
        </View>
      </GestureDetector>

      <View style={styles.stats} pointerEvents="none">
        <Text style={styles.statusText}>
          {mappingActive ? t('pointCloud.live') : t('pointCloud.frozen')}
        </Text>
        <Text style={styles.statsText}>{stats.points.toLocaleString()} pts</Text>
        <Text style={styles.statsText}>{stats.voxel.toFixed(2)} m · {stats.frameId}</Text>
      </View>

      <View style={styles.controls}>
        <ControlButton icon="scan-outline" onPress={() => setCamera({ yaw: 0, pitch: 0, zoom: 1 })} />
        <ControlButton icon="cube-outline" onPress={() => setCamera({ yaw: -0.7, pitch: 0.75, zoom: 1 })} />
        <ControlButton icon="trash-outline" onPress={clearPreview} destructive />
      </View>
    </View>
  );
}

function ControlButton({ icon, onPress, destructive = false }: {
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  destructive?: boolean;
}) {
  return (
    <TouchableOpacity style={styles.controlButton} onPress={onPress} activeOpacity={0.7}>
      <Ionicons
        name={icon}
        size={17}
        color={destructive ? theme.colors.statusError : theme.colors.textPrimary}
      />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: '#070A0F',
  },
  stats: {
    position: 'absolute',
    top: 8,
    left: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderDefault,
    backgroundColor: '#0D0D0DCC',
  },
  statusText: {
    color: theme.colors.statusConnected,
    fontFamily: 'SpaceMono',
    fontSize: 10,
    fontWeight: '700',
  },
  statsText: {
    color: theme.colors.textSecondary,
    fontFamily: 'SpaceMono',
    fontSize: 9,
    marginTop: 2,
  },
  controls: {
    position: 'absolute',
    top: 8,
    right: 8,
    flexDirection: 'row',
    gap: 5,
  },
  controlButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderDefault,
    backgroundColor: '#0D0D0DDD',
  },
});
