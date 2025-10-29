import { useAppState } from '@react-native-community/hooks';
import { useIsFocused } from '@react-navigation/core';
import {
  BlurStyle,
  Canvas,
  Circle,
  Group,
  Line,
  Path,
  Rect,
  Skia,
} from '@shopify/react-native-skia';
import React, { ReactNode, useEffect, useRef, useState } from 'react';
import { Button, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  CameraPosition,
  Frame,
  Camera as VisionCamera,
  useCameraDevice,
  useCameraPermission,
} from 'react-native-vision-camera';
import {
  Face,
  Camera as FaceDetectCamera,
  FaceDetectionOptions,
  Landmarks,
} from 'react-native-vision-camera-face-detector';

/** Entry */
function Index(): ReactNode {
  return (
    <SafeAreaProvider>
      <FaceDetection />
    </SafeAreaProvider>
  );
}

/** Component */
function FaceDetection(): ReactNode {
  const { width, height } = useWindowDimensions();
  const { hasPermission, requestPermission } = useCameraPermission();
  const [cameraMounted, setCameraMounted] = useState<boolean>(true);
  const [cameraPaused, setCameraPaused] = useState<boolean>(false);
  const [autoMode, setAutoMode] = useState<boolean>(true);
  const [cameraFacing, setCameraFacing] = useState<CameraPosition>('front');

  const faceDetectionOptions = useRef<FaceDetectionOptions>({
    performanceMode: 'fast',
    classificationMode: 'all',
    contourMode: 'all',
    landmarkMode: 'all',
    windowWidth: width,
    windowHeight: height,
  }).current;

  const isFocused = useIsFocused();
  const appState = useAppState();
  const isCameraActive = true;
  const cameraDevice = useCameraDevice(cameraFacing);

  const camera = useRef<VisionCamera>(null);

  // Anim values
  const aScanPhase = useSharedValue(0); // 0..1 sweep
  const aPulse = useSharedValue(0);     // 0..1 pulse
  const aLocked = useSharedValue(0);    // 0..1 lock

  // Stability / lock-on
  const stableFramesRef = useRef(0);
  const lastBoxRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  // For Canvas overlay
  const [faceBox, setFaceBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // ===== Smoothing helpers =====
  type Pt = { x: number; y: number };
  // All landmark keys from the SDK type
  type LmKey = keyof Landmarks;
  // Make `contours` non-nullable, then take its keys
  type AllContours = NonNullable<Face['contours']>;
  type CKey = keyof AllContours;

  const SMOOTHING = 0.25; // 0..1 (higher = snappier)

  const smoothPt = (prev: Pt | undefined, next: Pt): Pt => {
    if (!prev) return next;
    return { x: prev.x + (next.x - prev.x) * SMOOTHING, y: prev.y + (next.y - prev.y) * SMOOTHING };
  };
  const smoothArray = (prev?: Pt[], next?: Pt[]): Pt[] | undefined => {
    if (!next) return undefined;
    if (!prev || prev.length !== next.length) return next;
    return next.map((p, i) => smoothPt(prev[i], p));
  };

  // Smoothed stores (typed with our concrete keys)
  const smLandmarksRef = useRef<Partial<Record<LmKey, Pt>>>({});
  const smContoursRef = useRef<Partial<Record<CKey, Pt[]>>>({});

  // Scan + pulse animations
  useEffect(() => {
    aScanPhase.value = withRepeat(withTiming(1, { duration: 2000 }), -1, false);
    aPulse.value = withRepeat(withTiming(1, { duration: 1200 }), -1, true);
  }, []);

  // Permission
  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);

  // Rotation (kept if you need it later)
  const aRot = useSharedValue(0);
  function handleUiRotation(rotation: number) {
    aRot.value = rotation;
  }

  function handleCameraMountError(error: any) {
    console.error('camera mount error', error);
  }

  /** Detection */
  function handleFacesDetected(faces: Face[], frame: Frame): void {
    if (faces.length <= 0) {
      setFaceBox(null);
      aLocked.value = withTiming(0, { duration: 200 });
      stableFramesRef.current = 0;
      lastBoxRef.current = null;
      return;
    }

    // If multiple faces, use the largest
    const f = faces.reduce((best, cur) => {
      const a = best.bounds.width * best.bounds.height;
      const b = cur.bounds.width * cur.bounds.height;
      return b > a ? cur : best;
    }, faces[0]);

    const { width: bw, height: bh, x, y } = f.bounds;

    // ---- Smooth & store landmarks ----
    const rawLm = (f.landmarks ?? {}) as Partial<Record<LmKey, Pt>>;
    (Object.keys(rawLm) as LmKey[]).forEach((k) => {
      const nxt = rawLm[k];
      if (!nxt) return;
      const prev = smLandmarksRef.current[k];
      smLandmarksRef.current[k] = smoothPt(prev, nxt);
    });

    // ---- Smooth & store contours ----
    const rawCt = (f.contours ?? {}) as Partial<Record<CKey, Pt[]>>;
    (Object.keys(rawCt) as CKey[]).forEach((k) => {
      const nxt = rawCt[k];
      smContoursRef.current[k] = smoothArray(smContoursRef.current[k], nxt);
    });

    // Update box for overlay
    setFaceBox({ x, y, w: bw, h: bh });

    // Stability → lock
    const cx = x + bw / 2;
    const cy = y + bh / 2;
    const prev = lastBoxRef.current;
    const threshPos = 8;
    const threshSize = 10;
    if (prev) {
      const pcx = prev.x + prev.w / 2;
      const pcy = prev.y + prev.h / 2;
      const posOk = Math.hypot(cx - pcx, cy - pcy) < threshPos;
      const sizeOk = Math.abs(bw - prev.w) < threshSize && Math.abs(bh - prev.h) < threshSize;
      stableFramesRef.current = posOk && sizeOk ? stableFramesRef.current + 1 : 0;
    }
    lastBoxRef.current = { x, y, w: bw, h: bh };

    if (stableFramesRef.current > 10) {
      aLocked.value = withTiming(1, { duration: 250 });
    } else {
      aLocked.value = withTiming(0, { duration: 150 });
    }
  }

  return (
    <>
      <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
        {hasPermission && cameraDevice ? (
          <>
            {cameraMounted && (
              <>
                <FaceDetectCamera
                  ref={camera}
                  style={StyleSheet.absoluteFill}
                  isActive={isCameraActive}
                  device={cameraDevice}
                  onError={handleCameraMountError}
                  faceDetectionCallback={handleFacesDetected}
                  onUIRotationChanged={handleUiRotation}
                  faceDetectionOptions={{
                    ...faceDetectionOptions,
                    autoMode,
                    cameraFacing,
                    // skiaMode not required since we draw via Canvas overlay
                  }}
                />

                {/* === Skia overlay === */}
                <Canvas style={StyleSheet.absoluteFill}>
                  {faceBox && (
                    <Group>
                      {/* GRID */}
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Line
                          key={`v${i}`}
                          p1={{ x: faceBox.x + (faceBox.w * (i + 1)) / 6, y: faceBox.y }}
                          p2={{ x: faceBox.x + (faceBox.w * (i + 1)) / 6, y: faceBox.y + faceBox.h }}
                          color="rgba(0,255,255,0.18)"
                          strokeWidth={1}
                        />
                      ))}
                      {Array.from({ length: 5 }).map((_, j) => (
                        <Line
                          key={`h${j}`}
                          p1={{ x: faceBox.x, y: faceBox.y + (faceBox.h * (j + 1)) / 6 }}
                          p2={{ x: faceBox.x + faceBox.w, y: faceBox.y + (faceBox.h * (j + 1)) / 6 }}
                          color="rgba(0,255,255,0.18)"
                          strokeWidth={1}
                        />
                      ))}

                      {/* CORNER BRACKETS */}
                      {(() => {
                        const L = Math.min(faceBox.w, faceBox.h) * 0.15;
                        const path = Skia.Path.Make();
                        const { x: bx, y: by, w: bw, h: bh } = faceBox;
                        path.moveTo(bx, by + L); path.lineTo(bx, by); path.lineTo(bx + L, by);
                        path.moveTo(bx + bw - L, by); path.lineTo(bx + bw, by); path.lineTo(bx + bw, by + L);
                        path.moveTo(bx + bw, by + bh - L); path.lineTo(bx + bw, by + bh); path.lineTo(bx + bw - L, by + bh);
                        path.moveTo(bx + L, by + bh); path.lineTo(bx, by + bh); path.lineTo(bx, by + bh - L);
                        return <Path path={path} color="#00FFC8" style="stroke" strokeWidth={4} />;
                      })()}

                      {/* SWEEPING SCAN LINE + GLOW */}
                      {(() => {
                        const scanY = faceBox.y + faceBox.h * aScanPhase.value;
                        return (
                          <>
                            <Line
                              p1={{ x: faceBox.x, y: scanY }}
                              p2={{ x: faceBox.x + faceBox.w, y: scanY }}
                              color="rgba(0,255,128,0.9)"
                              strokeWidth={3}
                              // Skia web types sometimes bark on blur mask; works on native:
                              // @ts-ignore
                              maskFilter={Skia.MaskFilter.MakeBlur(BlurStyle.Normal, 1, true)}
                            />
                            <Rect
                              x={faceBox.x}
                              y={scanY - 12}
                              width={faceBox.w}
                              height={24}
                              color="rgba(0,255,128,0.12)"
                            />
                          </>
                        );
                      })()}

                      {/* ALL CONTOURS (neon polylines) */}
                      {(() => {
                        const ct = smContoursRef.current;

                        const draw = (key: CKey, color: string, close = false, width = 3) => {
                          const pts = ct[key];
                          if (!pts || pts.length < 2) return null;

                          const p = Skia.Path.Make();
                          p.moveTo(pts[0].x, pts[0].y);
                          for (let i = 1; i < pts.length; i++) p.lineTo(pts[i].x, pts[i].y);
                          if (close) p.close();

                          return (
                            <Path
                              key={String(key)}
                              path={p}
                              color={color}
                              style="stroke"
                              strokeWidth={width}
                            />
                          );
                        };

                        return (
                          <Group>
                            {draw('FACE', '#00FFC8', true, 4)}
                            {draw('LEFT_EYEBROW_TOP', '#00E5FF')}
                            {draw('LEFT_EYEBROW_BOTTOM', '#00E5FF')}
                            {draw('RIGHT_EYEBROW_TOP', '#00E5FF')}
                            {draw('RIGHT_EYEBROW_BOTTOM', '#00E5FF')}
                            {draw('LEFT_EYE', '#00B3FF', true, 2)}
                            {draw('RIGHT_EYE', '#00B3FF', true, 2)}
                            {draw('NOSE_BRIDGE', '#33FF99')}
                            {draw('NOSE_BOTTOM', '#33FF99')}
                            {draw('UPPER_LIP_TOP', '#00FF88')}
                            {draw('UPPER_LIP_BOTTOM', '#00FF88')}
                            {draw('LOWER_LIP_TOP', '#00FF88')}
                            {draw('LOWER_LIP_BOTTOM', '#00FF88')}
                            {draw('LEFT_CHEEK', '#00FFC8')}
                            {draw('RIGHT_CHEEK', '#00FFC8')}
                          </Group>
                        );
                      })()}

                      {/* ALL LANDMARK DOTS (pulsing) */}
                      {(() => {
                        const rBase = Math.max(2.2, Math.min(faceBox.w, faceBox.h) * 0.01);
                        const r =
                          rBase +
                          rBase * 0.7 * (aPulse.value < 0.5 ? aPulse.value : 1 - aPulse.value);
                        const entries = Object.entries(smLandmarksRef.current) as [
                          keyof Landmarks,
                          Pt
                        ][];
                        return entries.map(([k, p]) => (
                          <Group key={`lm-${String(k)}`}>
                            <Circle cx={p.x} cy={p.y} r={r + 2.5} color="rgba(0,255,128,0.12)" />
                            <Circle cx={p.x} cy={p.y} r={r} color="#00E5FF" />
                          </Group>
                        ));
                      })()}

                      {/* LOCK RING */}
                      {aLocked.value > 0.01 && (() => {
                        const cx = faceBox.x + faceBox.w / 2;
                        const cy = faceBox.y + faceBox.h / 2;
                        const radius =
                          Math.min(faceBox.w, faceBox.h) * (0.55 + 0.05 * aLocked.value);
                        return (
                          <>
                            <Circle
                              cx={cx}
                              cy={cy}
                              r={radius}
                              color={`rgba(0,255,0,${0.15 * aLocked.value})`}
                            />
                            <Circle
                              cx={cx}
                              cy={cy}
                              r={radius}
                              color="rgba(0,255,0,0.85)"
                              style="stroke"
                              strokeWidth={5}
                            />
                          </>
                        );
                      })()}
                    </Group>
                  )}
                </Canvas>

                {cameraPaused && (
                  <Text
                    style={{
                      width: '100%',
                      backgroundColor: 'rgb(0,0,255)',
                      textAlign: 'center',
                      color: 'white',
                    }}
                  >
                    Camera is PAUSED
                  </Text>
                )}
              </>
            )}

            {!cameraMounted && (
              <Text
                style={{
                  width: '100%',
                  backgroundColor: 'rgb(255,255,0)',
                  textAlign: 'center',
                }}
              >
                Camera is NOT mounted
              </Text>
            )}
          </>
        ) : (
          <Text
            style={{
              width: '100%',
              backgroundColor: 'rgb(255,0,0)',
              textAlign: 'center',
              color: 'white',
            }}
          >
            No camera device or permission
          </Text>
        )}
      </View>

      {/* Controls */}
      <View
        style={{
          position: 'absolute',
          bottom: 20,
          left: 0,
          right: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <View
          style={{
            width: '100%',
            display: 'flex',
            flexDirection: 'row',
            justifyContent: 'space-around',
          }}
        >
          <Button
            onPress={() =>
              setCameraFacing((current) => (current === 'front' ? 'back' : 'front'))
            }
            title={'Toggle Cam'}
          />
          <Button
            onPress={() => setAutoMode((current) => !current)}
            title={`${autoMode ? 'Disable' : 'Enable'} AutoMode`}
          />
        </View>

        <View
          style={{
            width: '100%',
            display: 'flex',
            flexDirection: 'row',
            justifyContent: 'space-around',
            marginTop: 10,
          }}
        >
          <Button
            onPress={() => setCameraPaused((current) => !current)}
            title={`${cameraPaused ? 'Resume' : 'Pause'} Cam`}
          />
          <Button
            onPress={() => setCameraMounted((current) => !current)}
            title={`${cameraMounted ? 'Unmount' : 'Mount'} Cam`}
          />
        </View>
      </View>
    </>
  );
}

export default Index;
