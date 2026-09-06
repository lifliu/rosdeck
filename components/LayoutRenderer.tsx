import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import type { LayoutNode } from '../types/layout';
import { getWidget } from '../widgets/registry';
import { useLayoutStore } from '../stores/useLayoutStore';
import { SplitDivider } from './SplitDivider';
import { LayoutEditor } from './LayoutEditor';
import { WidgetContentWrapper } from './WidgetContentWrapper';
import { useOrientation } from '../hooks/useOrientation';
import { theme } from '../constants/theme';
import { dispatchTouchStart, dispatchTouchMove, dispatchTouchEnd, setDeltaTransform } from '../lib/touch-dispatcher';

export function remapTouchToPortrait(
  lx: number, ly: number, isLandscape: boolean, containerWidth: number
): { px: number; py: number } {
  if (!isLandscape) return { px: lx, py: ly };
  return { px: ly, py: containerWidth - lx };
}

// Pure function for testing — computes the geometry of the layout tree
export type ResolvedNode =
  | { type: 'widget'; widgetType: string; config: Record<string, any>; nodeId: string; x: number; y: number; width: number; height: number }
  | { type: 'split'; direction: 'horizontal' | 'vertical'; nodeId: string; ratio: number; first: ResolvedNode; second: ResolvedNode; x: number; y: number; width: number; height: number };

export function resolveLayout(node: LayoutNode, width: number, height: number, x = 0, y = 0): ResolvedNode {
  if (node.type === 'widget') {
    return { type: 'widget', widgetType: node.widgetType, config: node.config, nodeId: node.id, x, y, width, height };
  }

  const { direction, ratio, children } = node;
  if (direction === 'vertical') {
    const firstH = Math.round(height * ratio);
    const secondH = height - firstH;
    return {
      type: 'split', direction, nodeId: node.id, ratio, x, y, width, height,
      first: resolveLayout(children[0], width, firstH, x, y),
      second: resolveLayout(children[1], width, secondH, x, y + firstH),
    };
  } else {
    const firstW = Math.round(width * ratio);
    const secondW = width - firstW;
    return {
      type: 'split', direction, nodeId: node.id, ratio, x, y, width, height,
      first: resolveLayout(children[0], firstW, height, x, y),
      second: resolveLayout(children[1], secondW, height, x + firstW, y),
    };
  }
}

interface RenderNodeProps {
  node: LayoutNode;
  width: number;
  height: number;
  parentSplitId?: string;
  parentDirection?: 'horizontal' | 'vertical';
}

function RenderNode({ node, width, height, parentSplitId, parentDirection }: RenderNodeProps) {
  const editMode = useLayoutStore((s) => s.editMode);
  const { isLandscape } = useOrientation();

  if (node.type === 'widget') {
    const widgetDef = getWidget(node.widgetType);
    if (!widgetDef) return <View style={{ width, height, backgroundColor: theme.colors.bgSurface }} />;
    const Widget = widgetDef.component;
    const contentWidth = width;
    const contentHeight = height;
    return (
      <View style={{ width, height, position: 'relative' }}>
        <WidgetContentWrapper width={width} height={height}>
          <Widget
            nodeId={node.id}
            config={node.config}
            onConfigChange={(newConfig) => {
              useLayoutStore.getState().updateWidgetConfig(node.id, newConfig);
            }}
            width={contentWidth}
            height={contentHeight}
          />
        </WidgetContentWrapper>
        {editMode && (
          <LayoutEditor
            nodeId={node.id}
            widgetType={node.widgetType}
            config={node.config}
            onConfigChange={(newConfig) => {
              useLayoutStore.getState().updateWidgetConfig(node.id, newConfig);
            }}
            parentSplitId={parentSplitId}
            parentDirection={parentDirection}
            paneWidth={width}
            paneHeight={height}
          />
        )}
      </View>
    );
  }

  const { direction, ratio, children } = node;
  // A portrait top/bottom split becomes a landscape left/right split. This
  // keeps camera, map and drive controls usable without rotating their text,
  // icons or gesture coordinate system.
  const effectiveDirection = isLandscape
    ? (direction === 'vertical' ? 'horizontal' : 'vertical')
    : direction;
  const isVertical = effectiveDirection === 'vertical';

  return (
    <View style={{ width, height, flexDirection: isVertical ? 'column' : 'row' }}>
      <RenderNode
        node={children[0]}
        width={isVertical ? width : Math.round(width * ratio)}
        height={isVertical ? Math.round(height * ratio) : height}
        parentSplitId={node.id}
        parentDirection={effectiveDirection}
      />
      <SplitDivider
        nodeId={node.id}
        direction={effectiveDirection}
        totalSize={isVertical ? height : width}
      />
      <RenderNode
        node={children[1]}
        width={isVertical ? width : width - Math.round(width * ratio)}
        height={isVertical ? height - Math.round(height * ratio) : height}
        parentSplitId={node.id}
        parentDirection={effectiveDirection}
      />
    </View>
  );
}

export function LayoutRenderer() {
  const layout = useLayoutStore((s) => s.getActiveLayout());
  const [size, setSize] = React.useState({ width: 0, height: 0 });
  const { isLandscape } = useOrientation();

  // Widgets now render natively in both orientations, so touch deltas stay in
  // screen coordinates. Reset explicitly when orientation or renderer changes.
  useEffect(() => {
    if (isLandscape) {
      setDeltaTransform((dx, dy) => ({ dx, dy }));
    } else {
      setDeltaTransform((dx, dy) => ({ dx, dy }));
    }
    return () => setDeltaTransform((dx, dy) => ({ dx, dy }));
  }, [isLandscape]);

  if (!layout) return null;

  const gridWidth = size.width;
  const gridHeight = size.height;

  return (
    <View
      style={styles.container}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        setSize({ width, height });
      }}
      onTouchStart={(e) => dispatchTouchStart([...e.nativeEvent.changedTouches])}
      onTouchMove={(e) => dispatchTouchMove([...e.nativeEvent.changedTouches])}
      onTouchEnd={(e) => dispatchTouchEnd([...e.nativeEvent.changedTouches])}
      onTouchCancel={(e) => dispatchTouchEnd([...e.nativeEvent.changedTouches])}
    >
      {size.width > 0 && size.height > 0 && (
        <RenderNode node={layout.tree} width={gridWidth} height={gridHeight} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bgBase,
  },
});
