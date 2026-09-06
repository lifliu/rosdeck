// components/WidgetContentWrapper.tsx
import React from 'react';
import { View } from 'react-native';

interface Props {
  width: number;
  height: number;
  children: React.ReactNode;
}

// Exported for testing
export function getContentDimensions(
  width: number, height: number, _isLandscape: boolean
): { contentWidth: number; contentHeight: number } {
  return { contentWidth: width, contentHeight: height };
}

export function WidgetContentWrapper({ width, height, children }: Props) {
  return <View style={{ width, height }}>{children}</View>;
}
