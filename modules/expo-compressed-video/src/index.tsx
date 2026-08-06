import { requireNativeViewManager } from 'expo-modules-core';
import React from 'react';
import type { ViewProps } from 'react-native';

export interface CompressedVideoViewRef {
  pushFrame(data: string, presentationTimeUs: number): Promise<void>;
  reset(): Promise<void>;
}

interface NativeCompressedVideoProps extends ViewProps {
  format: string;
}

const NativeCompressedVideoView: React.ComponentType<
  NativeCompressedVideoProps & React.RefAttributes<CompressedVideoViewRef>
> = requireNativeViewManager('ExpoCompressedVideo');

export const CompressedVideoView = React.forwardRef<
  CompressedVideoViewRef,
  NativeCompressedVideoProps
>((props, ref) => <NativeCompressedVideoView {...props} ref={ref} />);
