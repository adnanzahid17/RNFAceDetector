import { useAppState } from '@react-native-community/hooks';
import { useIsFocused } from '@react-navigation/core';
import {
  Canvas, Circle, Group,
  Path,
  Skia
} from '@shopify/react-native-skia';
import React, { ReactNode, useEffect, useRef, useState } from 'react';
import { Button, LayoutChangeEvent, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
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

export default function Index(): ReactNode {
  return (
    <SafeAreaProvider>
      <FaceDetection />
    </SafeAreaProvider>
  );
}

function FaceDetection(): ReactNode {
  const { width: winW, height: winH } = useWindowDimensions();
  const { hasPermission, requestPermission } = useCameraPermission();
  const [cameraMounted, setCameraMounted] = useState(true);
  const [cameraPaused, setCameraPaused] = useState(false);
  const [autoMode, setAutoMode] = useState(true);
  const [cameraFacing, setCameraFacing] = useState<CameraPosition>('front');

  // === Preview size measured from layout ===
  const [preview, setPreview] = useState({ w: winW, h: winH });
  const onPreviewLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setPreview({ w: width, h: height });
  };

  // Face detector options (updated when preview changes)
  const faceDetectionOptions = useRef<FaceDetectionOptions>({
    performanceMode: 'fast',
    classificationMode: 'all',
    contourMode: 'all',
    landmarkMode: 'all',
    windowWidth: preview.w,
    windowHeight: preview.h,
  }).current;
  useEffect(() => {
    faceDetectionOptions.windowWidth = preview.w;
    faceDetectionOptions.windowHeight = preview.h;
  }, [preview, faceDetectionOptions]);

  const isFocused = useIsFocused();
  const appState = useAppState();
  const isCameraActive = true;
  const cameraDevice = useCameraDevice(cameraFacing);
  const camera = useRef<VisionCamera>(null);

  // ===== Anim values =====
  const aScanPhase = useSharedValue(0);
  const aPulse = useSharedValue(0);
  const aLocked = useSharedValue(0);

  // ===== Face box as Reanimated shared values (no React state) =====
  const aFaceX = useSharedValue(0);
  const aFaceY = useSharedValue(0);
  const aFaceW = useSharedValue(0);
  const aFaceH = useSharedValue(0);

  // // Mirror Reanimated → Skia Values (Canvas re-draws when these change)
  // const fbX = useValue(0);
  // const fbY = useValue(0);
  // const fbW = useValue(0);
  // const fbH = useValue(0);

  // useSharedValueEffect(() => { fbX.current = aFaceX.value; }, aFaceX);
  // useSharedValueEffect(() => { fbY.current = aFaceY.value; }, aFaceY);
  // useSharedValueEffect(() => { fbW.current = aFaceW.value; }, aFaceW);
  // useSharedValueEffect(() => { fbH.current = aFaceH.value; }, aFaceH);
  // NEW: face box ref (no state churn per frame)
  const fbRef = useRef({ x: 0, y: 0, w: 0, h: 0 });

  // NEW: raf tick to re-render at most once per frame
  const [tick, setTick] = useState(0);
  const rafRef = useRef<number | null>(null);
  const scheduleFrame = () => {
    if (rafRef.current != null) return; // already scheduled
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setTick((t) => (t + 1) % 1_000_000);
    });
  };
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);
  // Stability / lock
  const stableFramesRef = useRef(0);
  const lastBoxRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  // ===== Smoothing helpers =====
  type Pt = { x: number; y: number };
  type LmKey = keyof Landmarks;
  type AllContours = NonNullable<Face['contours']>;
  type CKey = keyof AllContours;

  const SMOOTHING = 0.42; // a bit snappier than before

  const smoothPt = (prev: Pt | undefined, next: Pt): Pt =>
    !prev ? next : { x: prev.x + (next.x - prev.x) * SMOOTHING, y: prev.y + (next.y - prev.y) * SMOOTHING };

  const smoothArray = (prev?: Pt[], next?: Pt[]): Pt[] | undefined => {
    if (!next) return undefined;
    if (!prev || prev.length !== next.length) return next;
    return next.map((p, i) => smoothPt(prev[i], p));
  };

  // Smoothed stores
  const smLandmarksRef = useRef<Partial<Record<LmKey, Pt>>>({});
  const smContoursRef = useRef<Partial<Record<CKey, Pt[]>>>({});

  // Mirror helpers
  const mirrorBox = (b: { x: number; y: number; w: number; h: number }, W: number) => ({
    x: W - (b.x + b.w),
    y: b.y,
    w: b.w,
    h: b.h,
  });
  const mirrorPt = (p: Pt, W: number): Pt => ({ x: W - p.x, y: p.y });
  const mirrorArray = (arr: Pt[] | undefined, W: number) => (arr ? arr.map((p) => mirrorPt(p, W)) : arr);

  // Animations
  useEffect(() => {
    aScanPhase.value = withRepeat(withTiming(1, { duration: 2000 }), -1, false);
    aPulse.value = withRepeat(withTiming(1, { duration: 1200 }), -1, true);
  }, []);

  // Permission
  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);

  const aRot = useSharedValue(0);
  function handleUiRotation(rotation: number) {
    aRot.value = rotation;
  }
  function handleCameraMountError(error: any) {
    console.error('camera mount error', error);
  }

  /** Detection */
  function handleFacesDetected(faces: Face[], _frame: Frame): void {
    if (faces.length <= 0) {
      fbRef.current = { x: 0, y: 0, w: 0, h: 0 };
      scheduleFrame();
      aLocked.value = withTiming(0, { duration: 120 });
      stableFramesRef.current = 0;
      lastBoxRef.current = null;
      return;
    }

    // Largest face
    const f = faces.reduce((best, cur) => {
      const a = best.bounds.width * best.bounds.height;
      const b = cur.bounds.width * cur.bounds.height;
      return b > a ? cur : best;
    }, faces[0]);

    // Raw
    let { width: bw, height: bh, x, y } = f.bounds;
    let rawLm = (f.landmarks ?? {}) as Partial<Record<LmKey, Pt>>;
    let rawCt = (f.contours ?? {}) as Partial<Record<CKey, Pt[]>>;

    // Mirror for front camera
    if (cameraFacing === 'front') {
      const mb = mirrorBox({ x, y, w: bw, h: bh }, preview.w);
      x = mb.x; y = mb.y; bw = mb.w; bh = mb.h;

      (Object.keys(rawLm) as LmKey[]).forEach((k) => {
        const p = rawLm[k];
        if (p) rawLm[k] = mirrorPt(p, preview.w);
      });
      (Object.keys(rawCt) as CKey[]).forEach((k) => {
        rawCt[k] = mirrorArray(rawCt[k], preview.w);
      });
    }

    // Smooth & store (doesn't trigger React renders)
    (Object.keys(rawLm) as LmKey[]).forEach((k) => {
      const nxt = rawLm[k];
      if (!nxt) return;
      smLandmarksRef.current[k] = smoothPt(smLandmarksRef.current[k], nxt);
    });
    (Object.keys(rawCt) as CKey[]).forEach((k) => {
      const nxt = rawCt[k];
      smContoursRef.current[k] = smoothArray(smContoursRef.current[k], nxt);
    });

    // Update shared values (→ Skia values) — fast path
    fbRef.current = { x, y, w: bw, h: bh };
    scheduleFrame();
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
    aLocked.value = withTiming(stableFramesRef.current > 10 ? 1 : 0, { duration: 180 });
  }

  return (
    <>
      <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
        {hasPermission && cameraDevice ? (
          <>
            {cameraMounted && (
              <>
                <View style={StyleSheet.absoluteFill} onLayout={onPreviewLayout}>
                  <FaceDetectCamera
                    ref={camera}
                    style={StyleSheet.absoluteFill}
                    isActive={isCameraActive}
                    device={cameraDevice}
                    resizeMode="contain"
                    onError={handleCameraMountError}
                    faceDetectionCallback={handleFacesDetected}
                    onUIRotationChanged={handleUiRotation}
                    faceDetectionOptions={{
                      ...faceDetectionOptions,
                      autoMode,
                      cameraFacing,
                    }}
                  />

                  {/* === Skia overlay — fully driven by Skia/Reanimated values (no React setState) === */}
                  <Canvas style={StyleSheet.absoluteFill}>
                    {/* use IIFE to read current values */}
                    {(() => {
                      // force Canvas to re-evaluate when tick changes
                      void tick;

                      const { x: bx, y: by, w: bw, h: bh } = fbRef.current;
                      if (bw <= 0 || bh <= 0) return null;

                      return (
                        <Group>
                          {/* ALL CONTOURS */}
                          {(() => {
                            const ct = smContoursRef.current;
                            const draw = (key: CKey, color: string, close = false, width = 3) => {
                              const pts = ct[key];
                              if (!pts || pts.length < 2) return null;
                              const p = Skia.Path.Make();
                              p.moveTo(pts[0].x, pts[0].y);
                              for (let i = 1; i < pts.length; i++) p.lineTo(pts[i].x, pts[i].y);
                              if (close) p.close();
                              return <Path key={String(key)} path={p} color={color} style="stroke" strokeWidth={width} />;
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

                          {/* ALL LANDMARK DOTS */}
                          {(() => {
                            const entries = Object.entries(smLandmarksRef.current) as [LmKey, Pt][];
                            const rBase = Math.max(2.2, Math.min(bw, bh) * 0.01);
                            const r = rBase + rBase * 0.7 * (aPulse.value < 0.5 ? aPulse.value : 1 - aPulse.value);
                            return entries.map(([k, p]) => (
                              <Group key={`lm-${String(k)}`}>
                                <Circle cx={p.x} cy={p.y} r={r + 2.5} color="rgba(0,255,128,0.12)" />
                                <Circle cx={p.x} cy={p.y} r={r} color="#00E5FF" />
                              </Group>
                            ));
                          })()}

                          {/* LOCK RING */}
                          {aLocked.value > 0.01 && (() => {
                            const cx = bx + bw / 2;
                            const cy = by + bh / 2;
                            const radius = Math.min(bw, bh) * (0.55 + 0.05 * aLocked.value);
                            return (
                              <>
                                <Circle cx={cx} cy={cy} r={radius} color={`rgba(0,255,0,${0.15 * aLocked.value})`} />
                                <Circle cx={cx} cy={cy} r={radius} color="rgba(0,255,0,0.85)" style="stroke" strokeWidth={5} />
                              </>
                            );
                          })()}
                        </Group>
                      );
                    })()}
                  </Canvas>
                </View>

                {cameraPaused && (
                  <Text style={{ width: '100%', backgroundColor: 'rgb(0,0,255)', textAlign: 'center', color: 'white' }}>
                    Camera is PAUSED
                  </Text>
                )}
              </>
            )}

            {!cameraMounted && (
              <Text style={{ width: '100%', backgroundColor: 'rgb(255,255,0)', textAlign: 'center' }}>
                Camera is NOT mounted
              </Text>
            )}
          </>
        ) : (
          <Text style={{ width: '100%', backgroundColor: 'rgb(255,0,0)', textAlign: 'center', color: 'white' }}>
            No camera device or permission
          </Text>
        )}
      </View>

      {/* Controls */}
      <View style={{ position: 'absolute', bottom: 20, left: 0, right: 0, display: 'flex', flexDirection: 'column' }}>
        <View style={{ width: '100%', display: 'flex', flexDirection: 'row', justifyContent: 'space-around' }}>
          <Button onPress={() => setCameraFacing((c) => (c === 'front' ? 'back' : 'front'))} title={'Toggle Cam'} />
          <Button onPress={() => setAutoMode((c) => !c)} title={`${autoMode ? 'Disable' : 'Enable'} AutoMode`} />
        </View>
        <View style={{ width: '100%', display: 'flex', flexDirection: 'row', justifyContent: 'space-around', marginTop: 10 }}>
          <Button onPress={() => setCameraPaused((c) => !c)} title={`${cameraPaused ? 'Resume' : 'Pause'} Cam`} />
          <Button onPress={() => setCameraMounted((c) => !c)} title={`${cameraMounted ? 'Unmount' : 'Mount'} Cam`} />
        </View>
      </View>
    </>
  );
}
