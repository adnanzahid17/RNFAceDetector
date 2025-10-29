import LottieView from 'lottie-react-native';
import React, { ReactNode, useEffect, useRef, useState } from 'react';
import { Button, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  CameraPosition,
  Frame,
  useCameraDevice,
  useCameraPermission,
  Camera as VisionCamera,
} from 'react-native-vision-camera';
import {
  Face,
  Camera as FaceDetectCamera,
  FaceDetectionOptions,
} from 'react-native-vision-camera-face-detector';

export default function Index(): ReactNode {
  return (
    <SafeAreaProvider>
      <FaceScanHUDSwitcher />
    </SafeAreaProvider>
  );
}

function FaceScanHUDSwitcher(): ReactNode {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const { hasPermission, requestPermission } = useCameraPermission();
  const cameraDevice = useCameraDevice('front');
  const cameraRef = useRef<VisionCamera>(null);

  const [cameraFacing, setCameraFacing] = useState<CameraPosition>('front');
  const [cameraPaused, setCameraPaused] = useState(false);
  const [isFaceCentered, setIsFaceCentered] = useState(false);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);

  const lastCenterLogRef = useRef(0);
  const HUD_VERTICAL_OFFSET = -screenHeight * 0.12;
  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);

  const faceDetectionOptions: FaceDetectionOptions = {
    performanceMode: 'fast',
    classificationMode: 'none',
    contourMode: 'none',
    landmarkMode: 'none',
    windowWidth: frameSize?.width ?? screenWidth,
    windowHeight: frameSize?.height ?? screenHeight,
  };

  function onFacesDetected(faces: Face[], frame: Frame) {
    // Record frame size once
    // @ts-ignore VisionCamera frame width/height
    const fw: number | undefined = frame?.width;
    // @ts-ignore
    const fh: number | undefined = frame?.height;
    if (fw && fh && (!frameSize || frameSize.width !== fw || frameSize.height !== fh)) {
      setFrameSize({ width: fw, height: fh });
    }

    if (!faces || faces.length === 0 || !fw || !fh) {
      setIsFaceCentered(false);
      return;
    }

    const f = faces[0];
    const { x, y, width, height } = f.bounds;
    const faceCenterX = x + width / 2;
    const faceCenterY = y + height / 2;

    const normX = faceCenterX / fw;
    const normY = faceCenterY / fh;
    const tolerance = 0.12;

    const centered =
      Math.abs(normX - 0.5) <= tolerance && Math.abs(normY - 0.5) <= tolerance;

    // Throttle logs & prevent flicker by minor movement
    const now = Date.now();
    if (centered && now - lastCenterLogRef.current > 500) {
      console.log('[FaceScanHUDSwitcher] Face centered:', {
        normX: normX.toFixed(3),
        normY: normY.toFixed(3),
      });
      lastCenterLogRef.current = now;
      // TODO: Add logic when face is centered (e.g., verify identity, take snapshot)
    }

    setIsFaceCentered(centered);
  }

  const isActive = !cameraPaused;

  return (
    <>
      <View style={StyleSheet.absoluteFill}>
        {hasPermission && cameraDevice ? (
          <>
            <FaceDetectCamera
              ref={cameraRef}
              style={StyleSheet.absoluteFill}
              device={cameraDevice}
              isActive={isActive}
              faceDetectionOptions={faceDetectionOptions}
              faceDetectionCallback={onFacesDetected}
              onError={(e) => console.error('[FaceScanHUDSwitcher] camera error:', e)}
            />

            {/* === Animated HUD Overlay === */}
            <View pointerEvents="none" style={[styles.hudContainer, { transform: [{ translateY: HUD_VERTICAL_OFFSET }] }]}>
              <LottieView
                key={isFaceCentered ? 'centered' : 'default'}
                source={
                  !isFaceCentered
                    ? require('../assets/face_hud_centered.json')
                    : require('../assets/face_hud.json')
                }
                autoPlay
                loop
                speed={1.5}
                style={styles.hudLottie}
              />
            </View>
          </>
        ) : (
          <Text style={styles.permissionBanner}>No camera device or permission</Text>
        )}
      </View>

      {/* Controls for testing */}
      <View style={styles.controlsBar}>
        <View style={styles.controlsRow}>
          <Button
            title={cameraPaused ? 'Resume Camera' : 'Pause Camera'}
            onPress={() => setCameraPaused((p) => !p)}
          />
          <Button
            title={`Use ${cameraFacing === 'front' ? 'Back' : 'Front'} Camera`}
            onPress={() => setCameraFacing((f) => (f === 'front' ? 'back' : 'front'))}
          />
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  permissionBanner: {
    width: '100%',
    backgroundColor: 'rgb(255,0,0)',
    color: '#fff',
    textAlign: 'center',
    paddingVertical: 10,
  },
  controlsBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 20,
  },
  controlsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  hudContainer: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hudLottie: {
    width: '100%',
    aspectRatio: 1,
  },
});
