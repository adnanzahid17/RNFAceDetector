import { useAppState } from '@react-native-community/hooks';
import { useIsFocused } from '@react-navigation/core';
import { BlurStyle, Canvas, Circle, Group, Line, Path, Rect, Skia } from '@shopify/react-native-skia';
import React, { ReactNode, useEffect, useRef, useState } from 'react';
import { Button, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { CameraPosition, DrawableFrame, Frame, Camera as VisionCamera, useCameraDevice, useCameraPermission } from 'react-native-vision-camera';
import { Face, Camera as FaceDetectCamera, FaceDetectionOptions, Landmarks } from 'react-native-vision-camera-face-detector';
import { runOnJS } from 'react-native-worklets';

/**
 * Entry point component
 *
 * @return {ReactNode} Component
 */
function Index(): ReactNode {
  return (
    <SafeAreaProvider>

      <FaceDetection />

    </SafeAreaProvider>
  )
}

/**
 * Face detection component
 *
 * @return {ReactNode} Component
 */
function FaceDetection(): ReactNode {
  const {
    width,
    height
  } = useWindowDimensions()
  const { hasPermission, requestPermission } = useCameraPermission()
  const [cameraMounted, setCameraMounted] = useState<boolean>(true)
  const [cameraPaused, setCameraPaused] = useState<boolean>(false)
  const [autoMode, setAutoMode] = useState<boolean>(true)
  const [cameraFacing, setCameraFacing] = useState<CameraPosition>('front')
  const faceDetectionOptions = useRef<FaceDetectionOptions>({
    performanceMode: 'fast',
    classificationMode: 'all',
    contourMode: 'all',
    landmarkMode: 'all',
    windowWidth: width,
    windowHeight: height
  }).current
  const isFocused = useIsFocused()
  const appState = useAppState()
  const isCameraActive = (true)
  const cameraDevice = useCameraDevice(cameraFacing)
  //
  // vision camera ref
  //
  const camera = useRef<VisionCamera>(null)
  // --- SCIFI overlay animation values ---
  const aScanPhase = useSharedValue(0);     // 0..1 sweep inside face rect
  const aPulse = useSharedValue(0);     // 0..1 repeating pulse
  const aLocked = useSharedValue(0);     // 0..1 when lock acquired

  // simple stability counter to "lock" when face is steady for N frames
  const stableFramesRef = useRef(0);
  const lastBoxRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const [faceBox, setFaceBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [lm, setLm] = useState<Partial<Record<keyof Landmarks, { x: number; y: number }>>>({});
  //
  // face rectangle position
  //
  const aFaceW = useSharedValue(0)
  const aFaceH = useSharedValue(0)
  const aFaceX = useSharedValue(0)
  const aFaceY = useSharedValue(0)
  const aRot = useSharedValue(0)
  // const boundingBoxStyle = useAnimatedStyle(() => ({
  //   position: 'absolute',
  //   borderWidth: 4,
  //   borderLeftColor: 'rgba(30, 0, 255, 1)',
  //   borderRightColor: 'rgba(255, 234, 6, 1)',
  //   borderBottomColor: 'rgb(0,255,0)',
  //   borderTopColor: 'rgb(255,0,0)',
  //   width: withTiming(aFaceW.value, {
  //     duration: 100
  //   }),
  //   height: withTiming(aFaceH.value, {
  //     duration: 100
  //   }),
  //   left: withTiming(aFaceX.value, {
  //     duration: 100
  //   }),
  //   top: withTiming(aFaceY.value, {
  //     duration: 100
  //   }),
  //   transform: [{
  //     rotate: `${aRot.value}deg`
  //   }]
  // }))
  useEffect(() => {
    // Start continuous vertical sweep (0 → 1 → restart)
    aScanPhase.value = withRepeat(
      withTiming(1, {
        duration: 2000,
        // easing: Easing.inOut(Easing.quad) // uncomment for smoother wave motion
      }),
      -1,   // -1 = infinite repeat
      false // don't reverse; restart from 0
    );

    // Start soft pulse for landmarks / reticle (0 ↔ 1)
    aPulse.value = withRepeat(
      withTiming(1, {
        duration: 1200,
      }),
      -1,   // infinite repeat
      true  // reverse back and forth
    );
  }, []);
  useEffect(() => {
    if (hasPermission) return
    requestPermission()
  }, [])

  /**
   * Handle camera UI rotation
   * 
   * @param {number} rotation Camera rotation
   */
  function handleUiRotation(
    rotation: number
  ) {
    aRot.value = rotation
  }

  /**
   * Hanldes camera mount error event
   *
   * @param {any} error Error event
   */
  function handleCameraMountError(
    error: any
  ) {
    console.error('camera mount error', error)
  }

  /**
   * Handle detection result
   * 
   * @param {Face[]} faces Detection result 
   * @param {Frame} frame Current frame
   * @returns {void}
   */
  function handleFacesDetected(faces: Face[], frame: Frame): void {

    if (faces.length <= 0) {
      aFaceW.value = 0; aFaceH.value = 0; aFaceX.value = 0; aFaceY.value = 0;
      aLocked.value = withTiming(0, { duration: 200 });
      stableFramesRef.current = 0;
      lastBoxRef.current = null;
      return;
    }
    console.log("Faces:" + faces.length)
    const { bounds } = faces[0];
    const f = faces[0];
    const { width, height, x, y } = bounds;
    aFaceW.value = width; aFaceH.value = height; aFaceX.value = x; aFaceY.value = y;

    setFaceBox({ x, y, w: width, h: height });
    setLm({
      LEFT_EYE: f.landmarks?.LEFT_EYE,
      RIGHT_EYE: f.landmarks?.RIGHT_EYE,
      MOUTH_BOTTOM: f.landmarks?.MOUTH_BOTTOM,
    });
    aFaceW.value = width;
    aFaceH.value = height;
    aFaceX.value = x;
    aFaceY.value = y;

    // —— stability check (center & size jitter thresholds) ——
    const cx = x + width / 2, cy = y + height / 2;
    const prev = lastBoxRef.current;
    const threshPos = 8;          // px jitter allowed
    const threshSize = 10;        // px size jitter allowed
    if (prev) {
      const pcx = prev.x + prev.w / 2, pcy = prev.y + prev.h / 2;
      const posOk = Math.hypot(cx - pcx, cy - pcy) < threshPos;
      const sizeOk = Math.abs(width - prev.w) < threshSize && Math.abs(height - prev.h) < threshSize;
      if (posOk && sizeOk) {
        stableFramesRef.current++;
      } else {
        stableFramesRef.current = 0;
      }
    }
    lastBoxRef.current = { x, y, w: width, h: height };

    // ~10 frames ≈ 0.6s at ~16ms/frame (adjust to your FPS)
    if (stableFramesRef.current > 10) {
      aLocked.value = withTiming(1, { duration: 250 });
    } else {
      aLocked.value = withTiming(0, { duration: 150 });
    }

    if (camera.current) {
      // optional: take photo / etc when locked
      // if (aLocked.value === 1) ...
    }
  }


  /**
   * Handle skia frame actions
   * 
   * @param {Face[]} faces Detection result 
   * @param {DrawableFrame} frame Current frame
   * @returns {void}
   */
  function handleSkiaActions(faces: Face[], frame: DrawableFrame): void {
    'worklet';
    runOnJS(console.log)('Skia action tick', faces.length);
    const p = Skia.Paint(); p.setColor(Skia.Color('#00FF00'));
    frame.drawCircle(8, 8, 4, p);
    console.log(faces.length)
    if (faces.length <= 0) return;

    const face = faces[0];
    const { bounds, contours, landmarks } = face;

    const bx = bounds.x;
    const by = bounds.y;
    const bw = bounds.width;
    const bh = bounds.height;

    // ======= PAINTS =======
    const gridPaint = Skia.Paint();
    gridPaint.setColor(Skia.Color('rgba(0,255,255,0.18)'));
    gridPaint.setStyle(1); // stroke
    gridPaint.setStrokeWidth(1);

    const bracketPaint = Skia.Paint();
    bracketPaint.setColor(Skia.Color('#00FFC8'));
    bracketPaint.setStyle(1);
    bracketPaint.setStrokeWidth(4);

    const scanPaint = Skia.Paint();
    scanPaint.setColor(Skia.Color('rgba(0,255,128,0.9)'));
    scanPaint.setStyle(1);
    scanPaint.setStrokeWidth(3);
    // soft glow around the scan line
    scanPaint.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, 1, true));

    const glowPaint = Skia.Paint();
    glowPaint.setColor(Skia.Color('rgba(0,255,128,0.12)'));
    glowPaint.setStyle(0); // fill

    const pointPaint = Skia.Paint();
    pointPaint.setColor(Skia.Color('#00E5FF'));

    const lockPaint = Skia.Paint();
    lockPaint.setColor(Skia.Color('rgba(0,255,0,0.85)'));
    lockPaint.setStyle(1);
    lockPaint.setStrokeWidth(5);

    // ======= GRID inside the face rect =======
    const cols = 6, rows = 6;
    for (let i = 1; i < cols; i++) {
      const x = bx + (bw * i) / cols;
      frame.drawLine(x, by, x, by + bh, gridPaint);
    }
    for (let j = 1; j < rows; j++) {
      const y = by + (bh * j) / rows;
      frame.drawLine(bx, y, bx + bw, y, gridPaint);
    }

    // ======= CORNER BRACKETS =======
    const L = Math.min(bw, bh) * 0.15; // bracket length
    const path = Skia.Path.Make();
    // TL
    path.moveTo(bx, by + L); path.lineTo(bx, by); path.lineTo(bx + L, by);
    // TR
    path.moveTo(bx + bw - L, by); path.lineTo(bx + bw, by); path.lineTo(bx + bw, by + L);
    // BR
    path.moveTo(bx + bw, by + bh - L); path.lineTo(bx + bw, by + bh); path.lineTo(bx + bw - L, by + bh);
    // BL
    path.moveTo(bx + L, by + bh); path.lineTo(bx, by + bh); path.lineTo(bx, by + bh - L);
    frame.drawPath(path, bracketPaint);

    // ======= SWEEPING SCAN LINE =======
    // aScanPhase: 0..1 maps to Y within face bounds
    const scanY = by + bh * aScanPhase.value;
    // main line
    frame.drawLine(bx, scanY, bx + bw, scanY, scanPaint);
    // hazy glow strip around the line
    const glowRect = Skia.XYWHRect(bx, scanY - 12, bw, 24);
    frame.drawRect(glowRect, glowPaint);

    // ======= PULSING LANDMARK DOTS (eyes & mouth) =======
    const rBase = Math.max(2.5, Math.min(bw, bh) * 0.012);
    const r = rBase + rBase * 0.8 * (aPulse.value < 0.5 ? aPulse.value : (1 - aPulse.value));
    const lmKeys: (keyof Landmarks)[] = ['LEFT_EYE', 'RIGHT_EYE', 'MOUTH_BOTTOM'];
    lmKeys.forEach(k => {
      const p = landmarks?.[k];
      if (!p) return;
      frame.drawCircle(p.x, p.y, r + 2.5, glowPaint);
      frame.drawCircle(p.x, p.y, r, pointPaint);
    });

    // ======= LOCK RING (when stable) =======
    if (aLocked.value > 0.01) {
      const cx = bx + bw / 2, cy = by + bh / 2;
      const radius = Math.min(bw, bh) * (0.55 + 0.05 * aLocked.value);
      const lockP = Skia.Paint();
      lockP.setColor(Skia.Color(`rgba(0,255,0,${0.15 * aLocked.value})`));
      lockP.setStyle(0);
      frame.drawCircle(cx, cy, radius, lockP);
      // ring
      frame.drawCircle(cx, cy, radius, lockPaint);
    }
  }

  useEffect(() => {
    // Log all keys available on the Camera component
    console.log('Camera keys:', Object.keys(FaceDetectCamera));

    // If you want to see if skiaActions is part of the propTypes or defaultProps
    console.log('Camera has skiaActions prop?', 'skiaActions' in (FaceDetectCamera as any));
  }, []);


  return (<>
    <View
      style={[
        StyleSheet.absoluteFill, {
          alignItems: 'center',
          justifyContent: 'center'
        }
      ]}
    >
      {hasPermission && cameraDevice ? <>
        {cameraMounted && <>
          <FaceDetectCamera
            // @ts-ignore
            onInitialized={() => setCameraMounted(true)}
            ref={camera}
            style={StyleSheet.absoluteFill}
            isActive={isCameraActive}
            device={cameraDevice}
            onError={handleCameraMountError}
            faceDetectionCallback={handleFacesDetected}
            onUIRotationChanged={handleUiRotation}
            // @ts-ignore
            skiaActions={handleSkiaActions}
            faceDetectionOptions={{
              ...faceDetectionOptions,
              autoMode,
              cameraFacing,

            }}
          />
          <Canvas style={StyleSheet.absoluteFill}>
            {faceBox && (
              <Group>
                {/** GRID */}
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

                {/** CORNER BRACKETS */}
                {(() => {
                  const L = Math.min(faceBox.w, faceBox.h) * 0.15;
                  const path = Skia.Path.Make();
                  const { x: bx, y: by, w: bw, h: bh } = faceBox;
                  // TL
                  path.moveTo(bx, by + L); path.lineTo(bx, by); path.lineTo(bx + L, by);
                  // TR
                  path.moveTo(bx + bw - L, by); path.lineTo(bx + bw, by); path.lineTo(bx + bw, by + L);
                  // BR
                  path.moveTo(bx + bw, by + bh - L); path.lineTo(bx + bw, by + bh); path.lineTo(bx + bw - L, by + bh);
                  // BL
                  path.moveTo(bx + L, by + bh); path.lineTo(bx, by + bh); path.lineTo(bx, by + bh - L);
                  return <Path path={path} color="#00FFC8" style="stroke" strokeWidth={4} />;
                })()}

                {/** SCAN LINE + GLOW */}
                {(() => {
                  const scanY = faceBox.y + faceBox.h * aScanPhase.value;
                  return (
                    <>
                      <Line
                        p1={{ x: faceBox.x, y: scanY }}
                        p2={{ x: faceBox.x + faceBox.w, y: scanY }}
                        color="rgba(0,255,128,0.9)"
                        strokeWidth={3}
                      // maskFilter={Skia.MaskFilter.MakeBlur(BlurStyle.Normal, 1, true)}
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

                {/** PULSING LANDMARK DOTS */}
                {(() => {
                  const rBase = Math.max(2.5, Math.min(faceBox.w, faceBox.h) * 0.012);
                  const r = rBase + rBase * 0.8 * (aPulse.value < 0.5 ? aPulse.value : 1 - aPulse.value);
                  const keys: (keyof Landmarks)[] = ['LEFT_EYE', 'RIGHT_EYE', 'MOUTH_BOTTOM'];
                  return keys.map((k) => {
                    const p = lm[k];
                    if (!p) return null;
                    return (
                      <Group key={k}>
                        <Circle cx={p.x} cy={p.y} r={r + 2.5} color="rgba(0,255,128,0.12)" />
                        <Circle cx={p.x} cy={p.y} r={r} color="#ff0000ff" />
                      </Group>
                    );
                  });
                })()}

                {/** LOCK RING */}
                {aLocked.value > 0.01 && (() => {
                  const cx = faceBox.x + faceBox.w / 2;
                  const cy = faceBox.y + faceBox.h / 2;
                  const radius = Math.min(faceBox.w, faceBox.h) * (0.55 + 0.05 * aLocked.value);
                  return (
                    <>
                      <Circle cx={cx} cy={cy} r={radius} color={`rgba(0,255,0,${0.15 * aLocked.value})`} />
                      <Circle cx={cx} cy={cy} r={radius} color="rgba(255, 0, 238, 0.85)" style="stroke" strokeWidth={5} />
                    </>
                  );
                })()}
              </Group>
            )}
          </Canvas>


          {cameraPaused && <Text
            style={{
              width: '100%',
              backgroundColor: 'rgb(0,0,255)',
              textAlign: 'center',
              color: 'white'
            }}
          >
            Camera is PAUSED
          </Text>}
        </>}

        {!cameraMounted && <Text
          style={{
            width: '100%',
            backgroundColor: 'rgb(255,255,0)',
            textAlign: 'center'
          }}
        >
          Camera is NOT mounted
        </Text>}
      </> : <Text
        style={{
          width: '100%',
          backgroundColor: 'rgb(255,0,0)',
          textAlign: 'center',
          color: 'white'
        }}
      >
        No camera device or permission
      </Text>}
    </View>

    <View
      style={{
        position: 'absolute',
        bottom: 20,
        left: 0,
        right: 0,
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <View
        style={{
          width: '100%',
          display: 'flex',
          flexDirection: 'row',
          justifyContent: 'space-around'
        }}
      >



      </View>

      <View
        style={{
          width: '100%',
          display: 'flex',
          flexDirection: 'row',
          justifyContent: 'space-around'
        }}
      >
        <Button
          onPress={() => setCameraFacing((current) => (
            current === 'front' ? 'back' : 'front'
          ))}
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
          justifyContent: 'space-around'
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
  </>)
}

export default Index