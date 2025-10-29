import { useEffect } from "react";
import { Text, View } from "react-native";
import { useCameraPermission } from "react-native-vision-camera";
export default function Index() {
  const { hasPermission, requestPermission } = useCameraPermission()
  // ask for camera permission
  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);
  return (
    <View
      style={{
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <Text>Edit app/index.tsx to edit this screen.</Text>
    </View>
  );
}
