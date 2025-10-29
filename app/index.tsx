import { useEffect } from "react";
import { Dimensions, StyleSheet } from "react-native";
import { Camera, useCameraDevice, useCameraFormat, useCameraPermission, useFrameProcessor } from "react-native-vision-camera";
export default function Index() {
  const { hasPermission, requestPermission } = useCameraPermission()
  // ask for camera permission
  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);
  const device = useCameraDevice('front')
  const format = useCameraFormat(device, [
    {
      videoResolution: Dimensions.get('window'),
    },
    {
      fps: 60,
    },
  ]);
  const frameProcessor = useFrameProcessor((frame) => {
    'worklet'

    console.log(`Frame: ${frame.width}x${frame.height} (${frame.pixelFormat})`)
  }, [])

  return (
    <Camera
      style={StyleSheet.absoluteFill}
      device={device}
      isActive={true}
      frameProcessor={frameProcessor}
      enableFpsGraph
      enableDepthData
      videoStabilizationMode='auto'
      photoQualityBalance='quality'
      format={format}
      fps={format?.maxFps} />
  );
}
