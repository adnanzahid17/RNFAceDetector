import { useEffect } from "react";
import { StyleSheet } from "react-native";
import { Camera, useCameraDevice, useCameraPermission } from "react-native-vision-camera";
export default function Index() {
  const { hasPermission, requestPermission } = useCameraPermission()
  // ask for camera permission
  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);
  const device = useCameraDevice('front')
  return (
    <Camera
      style={StyleSheet.absoluteFill}
      device={device}
      isActive={true}
    />
  );
}
