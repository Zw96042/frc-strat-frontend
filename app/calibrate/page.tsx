'use client';

import Link from "next/link";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import { fetchCalibration, fetchMatch, resolveArtifactUrl, updateCalibration } from "@/lib/api";
import { canvasPointToField, drawFieldBackground, FIELD_HEIGHT, FIELD_IMAGE_SRC, FIELD_WIDTH, fieldPointToCanvas, getFieldCanvasLayout } from "@/lib/fieldGeometry";
import { CalibrationEnvelope, MatchRecord, ViewCalibration } from "@/lib/types";

type ViewName = "left" | "main" | "right";
type CalibrationMode = "bbox" | "points";
type ImageSize = { width: number; height: number };
type ContainedRect = { left: number; top: number; width: number; height: number };

const VIEW_ORDER: ViewName[] = ["left", "main", "right"];
const LANDMARK_COLORS = ["#f4f1de", "#f6bd60", "#84a59d", "#f28482", "#9db4c0", "#d8a47f"];
const DISTORTION_SLIDER_MIN = -0.6;
const DISTORTION_SLIDER_MAX = 0.6;
const DISTORTION_SLIDER_STEP = 0.01;

function getContainedRect(boundsWidth: number, boundsHeight: number, mediaWidth: number, mediaHeight: number): ContainedRect {
  if (boundsWidth <= 0 || boundsHeight <= 0 || mediaWidth <= 0 || mediaHeight <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }

  const scale = Math.min(boundsWidth / mediaWidth, boundsHeight / mediaHeight);
  const width = mediaWidth * scale;
  const height = mediaHeight * scale;
  return {
    left: (boundsWidth - width) / 2,
    top: (boundsHeight - height) / 2,
    width,
    height,
  };
}

function getDistortionStrength(view: ViewCalibration): number {
  return Number.isFinite(view.distortion_strength) ? Number(view.distortion_strength) : 0;
}

function getDistortionX(view: ViewCalibration): number {
  return Number.isFinite(view.distortion_x) ? Number(view.distortion_x) : 0;
}

function getDistortionY(view: ViewCalibration): number {
  if (Number.isFinite(view.distortion_y)) return Number(view.distortion_y);
  return getDistortionStrength(view);
}

function distortPoint(point: [number, number], roi: number[], xStrength: number, yStrength: number): [number, number] {
  if (roi.length < 4 || (Math.abs(xStrength) < 1e-9 && Math.abs(yStrength) < 1e-9)) return point;
  const [x1, y1, x2, y2] = roi;
  const centerX = (x1 + x2) / 2;
  const centerY = (y1 + y2) / 2;
  const halfWidth = Math.max((x2 - x1) / 2, 1);
  const halfHeight = Math.max((y2 - y1) / 2, 1);
  const deltaX = point[0] - centerX;
  const deltaY = point[1] - centerY;
  const normalizedX = (point[0] - centerX) / halfWidth;
  const normalizedY = (point[1] - centerY) / halfHeight;
  const curvedOffsetX = xStrength * (normalizedY ** 2) * (deltaX / halfWidth) * halfWidth;
  const curvedOffsetY = yStrength * (normalizedX ** 2) * (deltaY / halfHeight) * halfHeight;
  return [
    point[0] + curvedOffsetX,
    point[1] + curvedOffsetY,
  ];
}

function undistortPoint(point: [number, number], roi: number[], xStrength: number, yStrength: number, iterations = 8): [number, number] {
  if (roi.length < 4 || (Math.abs(xStrength) < 1e-9 && Math.abs(yStrength) < 1e-9)) return point;
  let estimate: [number, number] = [point[0], point[1]];
  for (let index = 0; index < iterations; index += 1) {
    const projected = distortPoint(estimate, roi, xStrength, yStrength);
    estimate = [
      estimate[0] + (point[0] - projected[0]),
      estimate[1] + (point[1] - projected[1]),
    ];
  }
  return estimate;
}

function drawDistortionCorrectedImage(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  roi: number[],
  xStrength: number,
  yStrength: number,
) {
  const width = image.width;
  const height = image.height;
  const hasValidRoi = roi.length >= 4 && roi[2] > roi[0] && roi[3] > roi[1];
  if ((Math.abs(xStrength) < 1e-9 && Math.abs(yStrength) < 1e-9) || !hasValidRoi) {
    context.drawImage(image, 0, 0);
    return;
  }

  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = width;
  sourceCanvas.height = height;
  const sourceContext = sourceCanvas.getContext("2d");
  if (!sourceContext) {
    context.drawImage(image, 0, 0);
    return;
  }
  sourceContext.drawImage(image, 0, 0, width, height);
  const sourceImage = sourceContext.getImageData(0, 0, width, height);
  const outputImage = context.createImageData(width, height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourcePoint = undistortPoint([x, y], roi, xStrength, yStrength);
      const sourceX = Math.min(width - 1, Math.max(0, Math.round(sourcePoint[0])));
      const sourceY = Math.min(height - 1, Math.max(0, Math.round(sourcePoint[1])));
      const sourceIndex = (sourceY * width + sourceX) * 4;
      const outputIndex = (y * width + x) * 4;
      outputImage.data[outputIndex] = sourceImage.data[sourceIndex];
      outputImage.data[outputIndex + 1] = sourceImage.data[sourceIndex + 1];
      outputImage.data[outputIndex + 2] = sourceImage.data[sourceIndex + 2];
      outputImage.data[outputIndex + 3] = sourceImage.data[sourceIndex + 3];
    }
  }

  context.putImageData(outputImage, 0, 0);
}
function solveLinearSystem(matrix: number[][], vector: number[]): number[] | null {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);

  for (let pivot = 0; pivot < size; pivot += 1) {
    let bestRow = pivot;
    for (let row = pivot + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[bestRow][pivot])) {
        bestRow = row;
      }
    }

    if (Math.abs(augmented[bestRow][pivot]) < 1e-9) {
      return null;
    }

    if (bestRow !== pivot) {
      [augmented[pivot], augmented[bestRow]] = [augmented[bestRow], augmented[pivot]];
    }

    const pivotValue = augmented[pivot][pivot];
    for (let column = pivot; column <= size; column += 1) {
      augmented[pivot][column] /= pivotValue;
    }

    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue;
      const factor = augmented[row][pivot];
      if (Math.abs(factor) < 1e-9) continue;
      for (let column = pivot; column <= size; column += 1) {
        augmented[row][column] -= factor * augmented[pivot][column];
      }
    }
  }

  return augmented.map((row) => row[size]);
}

function projectImagePoint(point: [number, number], homography: number[][]): [number, number] | null {
  const [x, y] = point;
  const denominator = homography[2][0] * x + homography[2][1] * y + homography[2][2];
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-9) return null;

  const projectedX = (homography[0][0] * x + homography[0][1] * y + homography[0][2]) / denominator;
  const projectedY = (homography[1][0] * x + homography[1][1] * y + homography[1][2]) / denominator;
  if (!Number.isFinite(projectedX) || !Number.isFinite(projectedY)) return null;
  return [projectedX, projectedY];
}

function solveHomography(imagePoints: [number, number][], fieldPoints: [number, number][]): { homography: number[][]; error: number } | null {
  if (imagePoints.length < 4 || fieldPoints.length < 4) return null;

  const matrix: number[][] = [];
  const vector: number[] = [];

  for (let index = 0; index < 4; index += 1) {
    const [x, y] = imagePoints[index];
    const [u, v] = fieldPoints[index];

    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    vector.push(u);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    vector.push(v);
  }

  const solution = solveLinearSystem(matrix, vector);
  if (!solution) return null;

  const homography = [
    [solution[0], solution[1], solution[2]],
    [solution[3], solution[4], solution[5]],
    [solution[6], solution[7], 1],
  ];

  let totalError = 0;
  for (let index = 0; index < 4; index += 1) {
    const projected = projectImagePoint(imagePoints[index], homography);
    if (!projected) return null;
    totalError += Math.hypot(projected[0] - fieldPoints[index][0], projected[1] - fieldPoints[index][1]);
  }

  return {
    homography,
    error: totalError / 4,
  };
}

function deriveViewCalibration(view: ViewCalibration): ViewCalibration {
  if (view.roi.length < 4) return view;
  const [x1, y1, x2, y2] = view.roi;
  if (!(x2 > x1 && y2 > y1)) return view;
  const distortionX = getDistortionX(view);
  const distortionY = getDistortionY(view);
  const correctedOrigin = undistortPoint([x1, y1], view.roi, distortionX, distortionY);

  const firstFour = view.landmarks.slice(0, 4);
  if (firstFour.length < 4) return view;

  const imagePoints = firstFour.map((landmark) => {
    const corrected = undistortPoint([landmark.image_point[0], landmark.image_point[1]], view.roi, distortionX, distortionY);
    return [corrected[0] - correctedOrigin[0], corrected[1] - correctedOrigin[1]] as [number, number];
  });
  const fieldPoints = firstFour.map((landmark) => [landmark.field_point[0], landmark.field_point[1]] as [number, number]);

  const uniqueImagePoints = new Set(imagePoints.map((point) => `${point[0].toFixed(3)}:${point[1].toFixed(3)}`));
  if (uniqueImagePoints.size < 4) return view;

  const solved = solveHomography(imagePoints, fieldPoints);
  if (!solved) return view;

  return {
    ...view,
    homography: solved.homography,
    reprojection_error: solved.error,
  };
}

function invertHomography(homography: number[][]): number[][] | null {
  if (homography.length !== 3 || homography.some((row) => row.length !== 3)) return null;
  const [
    [a, b, c],
    [d, e, f],
    [g, h, i],
  ] = homography;
  const determinant =
    a * (e * i - f * h) -
    b * (d * i - f * g) +
    c * (d * h - e * g);

  if (Math.abs(determinant) < 1e-9) return null;

  return [
    [(e * i - f * h) / determinant, (c * h - b * i) / determinant, (b * f - c * e) / determinant],
    [(f * g - d * i) / determinant, (a * i - c * g) / determinant, (c * d - a * f) / determinant],
    [(d * h - e * g) / determinant, (b * g - a * h) / determinant, (a * e - b * d) / determinant],
  ];
}

function projectFieldPointToImage(fieldPoint: [number, number], homography: number[][], roi: number[], distortionX = 0, distortionY = 0): [number, number] | null {
  const inverse = invertHomography(homography);
  if (!inverse || roi.length < 2) return null;

  const [x1, y1] = roi;
  const correctedOrigin = undistortPoint([x1, y1], roi, distortionX, distortionY);
  const [fx, fy] = fieldPoint;
  const px = inverse[0][0] * fx + inverse[0][1] * fy + inverse[0][2];
  const py = inverse[1][0] * fx + inverse[1][1] * fy + inverse[1][2];
  const pw = inverse[2][0] * fx + inverse[2][1] * fy + inverse[2][2];

  if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pw) || Math.abs(pw) < 1e-9) {
    return null;
  }

  return [correctedOrigin[0] + px / pw, correctedOrigin[1] + py / pw];
}

function sampleFieldLine(
  start: [number, number],
  end: [number, number],
  homography: number[][],
  roi: number[],
  distortionX = 0,
  distortionY = 0,
  segments = 24,
): [number, number][] {
  const points: [number, number][] = [];
  for (let index = 0; index <= segments; index += 1) {
    const t = index / segments;
    const fieldPoint: [number, number] = [
      start[0] + (end[0] - start[0]) * t,
      start[1] + (end[1] - start[1]) * t,
    ];
    const projected = projectFieldPointToImage(fieldPoint, homography, roi, distortionX, distortionY);
    if (projected) points.push(projected);
  }
  return points;
}

function midpoint(a: [number, number], b: [number, number]): [number, number] {
  return [
    (a[0] + b[0]) / 2,
    (a[1] + b[1]) / 2,
  ];
}

function getCalibrationOverlayFieldLines(view: ViewCalibration) {
  return {
    perimeterCorners: [
      [-FIELD_WIDTH / 2, FIELD_HEIGHT / 2],
      [FIELD_WIDTH / 2, FIELD_HEIGHT / 2],
      [FIELD_WIDTH / 2, -FIELD_HEIGHT / 2],
      [-FIELD_WIDTH / 2, -FIELD_HEIGHT / 2],
    ] as [number, number][],
    verticalGuide: [
      [0, FIELD_HEIGHT / 2],
      [0, -FIELD_HEIGHT / 2],
    ] as [[number, number], [number, number]],
    horizontalGuide: [
      [-FIELD_WIDTH / 2, 0],
      [FIELD_WIDTH / 2, 0],
    ] as [[number, number], [number, number]],
  };
}

function splitProjectedLine(points: [number, number][], canvasWidth: number, canvasHeight: number): [number, number][][] {
  if (points.length < 2) return points.length ? [points] : [];

  const maxJump = Math.max(canvasWidth, canvasHeight) * 0.35;
  const maxCoordinate = Math.max(canvasWidth, canvasHeight) * 4;
  const segments: [number, number][][] = [];
  let current: [number, number][] = [];

  for (const point of points) {
    const [x, y] = point;
    const finite = Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= maxCoordinate && Math.abs(y) <= maxCoordinate;
    if (!finite) {
      if (current.length >= 2) segments.push(current);
      current = [];
      continue;
    }

    const previous = current[current.length - 1];
    if (previous) {
      const jump = Math.hypot(x - previous[0], y - previous[1]);
      if (jump > maxJump) {
        if (current.length >= 2) segments.push(current);
        current = [point];
        continue;
      }
    }

    current.push(point);
  }

  if (current.length >= 2) segments.push(current);
  return segments;
}

function cloneCalibration(calibration: CalibrationEnvelope): CalibrationEnvelope {
  return JSON.parse(JSON.stringify(calibration)) as CalibrationEnvelope;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function findNearestLandmarkIndex(
  point: [number, number],
  view: ViewCalibration,
  canvasWidth: number,
  canvasHeight: number,
  padding = 72,
): number | null {
  if (!view.landmarks.length) return null;
  const layout = getFieldCanvasLayout(canvasWidth, canvasHeight, padding);

  let bestIndex: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [index, landmark] of view.landmarks.entries()) {
    const [x, y] = fieldPointToCanvas([landmark.field_point[0], landmark.field_point[1]], layout);
    const distance = Math.hypot(point[0] - x, point[1] - y);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function CalibratePageContent() {
  const searchParams = useSearchParams();
  const matchId = searchParams.get("match");

  const [match, setMatch] = useState<MatchRecord | null>(null);
  const [calibration, setCalibration] = useState<CalibrationEnvelope | null>(null);
  const [currentView, setCurrentView] = useState<ViewName>("main");
  const [mode, setMode] = useState<CalibrationMode>("bbox");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playableVideoUrl, setPlayableVideoUrl] = useState<string | null>(null);
  const [frameImages, setFrameImages] = useState<Record<ViewName, string | null>>({
    left: null,
    main: null,
    right: null,
  });
  const [frameImageSizes, setFrameImageSizes] = useState<Record<ViewName, ImageSize | null>>({
    left: null,
    main: null,
    right: null,
  });
  const [frameCanvasSize, setFrameCanvasSize] = useState<ImageSize>({ width: 0, height: 0 });
  const [pointCursor, setPointCursor] = useState<Record<ViewName, number>>({
    left: 0,
    main: 0,
    right: 0,
  });
  const [selectedLandmarkIndex, setSelectedLandmarkIndex] = useState(0);
  const [bboxStart, setBboxStart] = useState<[number, number] | null>(null);
  const [fieldDragging, setFieldDragging] = useState(false);
  const [fieldImageVersion, setFieldImageVersion] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  const frameCanvasRef = useRef<HTMLCanvasElement>(null);
  const frameCanvasContainerRef = useRef<HTMLDivElement>(null);
  const fieldCanvasRef = useRef<HTMLCanvasElement>(null);
  const localVideoObjectUrlRef = useRef<string | null>(null);
  const fieldImageRef = useRef<HTMLImageElement | null>(null);
  const draggingLandmarkIndexRef = useRef<number | null>(null);

  useEffect(() => {
    const image = new window.Image();
    image.onload = () => setFieldImageVersion((value) => value + 1);
    image.src = FIELD_IMAGE_SRC;
    fieldImageRef.current = image;
  }, []);

  useEffect(() => {
    const container = frameCanvasContainerRef.current;
    if (!container) return;

    const updateSize = () => {
      setFrameCanvasSize({
        width: container.clientWidth,
        height: container.clientHeight,
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(container);
    return () => observer.disconnect();
  }, [calibration, currentView]);

  useEffect(() => {
    async function load() {
      if (!matchId) return;
      try {
        const [matchResponse, calibrationResponse] = await Promise.all([
          fetchMatch(matchId),
          fetchCalibration(matchId),
        ]);
        setMatch(matchResponse);
        setCalibration(calibrationResponse);
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : "Failed to load calibration.");
      }
    }
    load().catch(() => undefined);
  }, [matchId]);

  const videoUrl = useMemo(() => {
    if (!match) return null;
    return resolveArtifactUrl(match.artifacts.source_video ?? match.artifacts.annotated_video);
  }, [match]);

  useEffect(() => {
    async function prepareVideo() {
      if (!videoUrl) {
        setPlayableVideoUrl(null);
        return;
      }

      if (localVideoObjectUrlRef.current) {
        URL.revokeObjectURL(localVideoObjectUrlRef.current);
        localVideoObjectUrlRef.current = null;
      }

      try {
        const response = await fetch(videoUrl, { mode: "cors" });
        if (!response.ok) throw new Error(`Failed to load video (${response.status})`);
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        localVideoObjectUrlRef.current = objectUrl;
        setPlayableVideoUrl(objectUrl);
      } catch {
        setPlayableVideoUrl(videoUrl);
      }
    }

    prepareVideo().catch(() => undefined);

    return () => {
      if (localVideoObjectUrlRef.current) {
        URL.revokeObjectURL(localVideoObjectUrlRef.current);
        localVideoObjectUrlRef.current = null;
      }
    };
  }, [videoUrl]);

  const currentViewCalibration = useMemo(() => {
    const view = calibration?.views.find((entry) => entry.view === currentView) ?? null;
    return view ? deriveViewCalibration(view) : null;
  }, [calibration, currentView]);

  function updateView(mutator: (view: ViewCalibration) => ViewCalibration) {
    if (!calibration || !currentViewCalibration) return;
    const next = cloneCalibration(calibration);
    next.mode = "manual_override";
    next.updated_at = Date.now() / 1000;
    next.views = next.views.map((view) => (
      view.view === currentView ? deriveViewCalibration(mutator(view)) : view
    ));
    setCalibration(next);
  }

  function setFieldLandmarkPoint(index: number, fieldPoint: [number, number]) {
    updateView((view) => {
      const landmarks = view.landmarks.map((landmark, landmarkIndex) =>
        landmarkIndex === index
          ? {
              ...landmark,
              field_point: fieldPoint,
              confidence: 1,
            }
          : landmark,
      );
      return {
        ...view,
        landmarks,
        fallback_reason: "Manual landmark points adjusted on the top-down field.",
      };
    });
  }

  function setDistortionX(strength: number) {
    updateView((view) => ({
      ...view,
      distortion_x: strength,
      fallback_reason: "Manual X/Y distortion adjusted in calibration lab.",
    }));
  }

  function setDistortionY(strength: number) {
    updateView((view) => ({
      ...view,
      distortion_strength: strength,
      distortion_y: strength,
      fallback_reason: "Manual X/Y distortion adjusted in calibration lab.",
    }));
  }

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTimeUpdate = () => setCurrentTime(video.currentTime);
    const onEnded = () => setIsPlaying(false);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("ended", onEnded);
    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("ended", onEnded);
    };
  }, [videoUrl]);

  useEffect(() => {
    const maxIndex = Math.max((currentViewCalibration?.landmarks.length ?? 1) - 1, 0);
    setSelectedLandmarkIndex((current) => Math.min(current, maxIndex));
  }, [currentViewCalibration?.landmarks.length]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) {
      void video.play();
    } else {
      video.pause();
    }
  }, [isPlaying, videoUrl]);

  function captureCurrentFrame() {
    const video = videoRef.current;
    const canvas = captureCanvasRef.current;
    if (!video || !canvas) return;
    if (video.videoWidth <= 0 || video.videoHeight <= 0) {
      setStatusMessage("Wait for the video to finish loading, then capture the frame again.");
      return;
    }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/png");
    setFrameImages((current) => ({ ...current, [currentView]: dataUrl }));
    setFrameImageSizes((current) => ({
      ...current,
      [currentView]: { width: video.videoWidth, height: video.videoHeight },
    }));
    setStatusMessage(`Captured ${currentView} frame at ${formatTime(video.currentTime)}`);
  }

  function resetCurrentView() {
    if (!currentViewCalibration) return;
    updateView((view) => ({
      ...view,
      roi: [0, 0, 0, 0],
      distortion_strength: 0,
      distortion_x: 0,
      distortion_y: 0,
      landmarks: view.landmarks.map((landmark) => ({
        ...landmark,
        image_point: [0, 0],
      })),
      homography: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      reprojection_error: null,
      fallback_reason: "Manual recalibration in progress.",
    }));
    setPointCursor((current) => ({ ...current, [currentView]: 0 }));
    setBboxStart(null);
    setMode("bbox");
  }

  useEffect(() => {
    const canvas = frameCanvasRef.current;
    const imageUrl = frameImages[currentView];
    if (!canvas || !imageUrl || !currentViewCalibration || frameCanvasSize.width <= 0 || frameCanvasSize.height <= 0) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const image = new window.Image();
    image.onload = () => {
      canvas.width = frameCanvasSize.width;
      canvas.height = frameCanvasSize.height;
      context.clearRect(0, 0, canvas.width, canvas.height);

      setFrameImageSizes((current) => {
        const existing = current[currentView];
        if (existing?.width === image.width && existing?.height === image.height) return current;
        return {
          ...current,
          [currentView]: { width: image.width, height: image.height },
        };
      });

      const distortionX = getDistortionX(currentViewCalibration);
      const distortionY = getDistortionY(currentViewCalibration);
      const mediaRect = getContainedRect(canvas.width, canvas.height, image.width, image.height);

      const correctedCanvas = document.createElement("canvas");
      correctedCanvas.width = image.width;
      correctedCanvas.height = image.height;
      const correctedContext = correctedCanvas.getContext("2d");
      if (!correctedContext) return;

      drawDistortionCorrectedImage(correctedContext, image, currentViewCalibration.roi, distortionX, distortionY);
      context.drawImage(correctedCanvas, mediaRect.left, mediaRect.top, mediaRect.width, mediaRect.height);

      const scaleX = mediaRect.width / image.width;
      const scaleY = mediaRect.height / image.height;
      const toCanvasPoint = ([x, y]: [number, number]): [number, number] => [
        mediaRect.left + x * scaleX,
        mediaRect.top + y * scaleY,
      ];

      const [x1, y1, x2, y2] = currentViewCalibration.roi;
      if (x2 > x1 && y2 > y1) {
        const topLeft = toCanvasPoint(undistortPoint([x1, y1], currentViewCalibration.roi, distortionX, distortionY));
        const topRight = toCanvasPoint(undistortPoint([x2, y1], currentViewCalibration.roi, distortionX, distortionY));
        const bottomRight = toCanvasPoint(undistortPoint([x2, y2], currentViewCalibration.roi, distortionX, distortionY));
        const bottomLeft = toCanvasPoint(undistortPoint([x1, y2], currentViewCalibration.roi, distortionX, distortionY));
        context.strokeStyle = "#00ffa6";
        context.lineWidth = 3;
        context.beginPath();
        context.moveTo(topLeft[0], topLeft[1]);
        context.lineTo(topRight[0], topRight[1]);
        context.lineTo(bottomRight[0], bottomRight[1]);
        context.lineTo(bottomLeft[0], bottomLeft[1]);
        context.closePath();
        context.stroke();
      }

      currentViewCalibration.landmarks.forEach((landmark, index) => {
        const [x, y] = toCanvasPoint(undistortPoint([landmark.image_point[0], landmark.image_point[1]], currentViewCalibration.roi, distortionX, distortionY));
        if (x === 0 && y === 0) return;
        context.beginPath();
        context.arc(x, y, 12, 0, Math.PI * 2);
        context.fillStyle = LANDMARK_COLORS[index % LANDMARK_COLORS.length];
        context.fill();
        context.strokeStyle = "#ffffff";
        context.lineWidth = 2;
        context.stroke();
        context.fillStyle = "#061217";
        context.font = "bold 14px sans-serif";
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(String(index + 1), x, y);
      });

      const overlayLines = getCalibrationOverlayFieldLines(currentViewCalibration);
      const edgeSegments = overlayLines
        ? [
            sampleFieldLine(overlayLines.perimeterCorners[0], overlayLines.perimeterCorners[1], currentViewCalibration.homography, currentViewCalibration.roi, distortionX, distortionY),
            sampleFieldLine(overlayLines.perimeterCorners[1], overlayLines.perimeterCorners[2], currentViewCalibration.homography, currentViewCalibration.roi, distortionX, distortionY),
            sampleFieldLine(overlayLines.perimeterCorners[2], overlayLines.perimeterCorners[3], currentViewCalibration.homography, currentViewCalibration.roi, distortionX, distortionY),
            sampleFieldLine(overlayLines.perimeterCorners[3], overlayLines.perimeterCorners[0], currentViewCalibration.homography, currentViewCalibration.roi, distortionX, distortionY),
          ].map((edge) => edge.map((point) => toCanvasPoint(point)))
            .flatMap((edge) => splitProjectedLine(edge, canvas.width, canvas.height))
        : [];
      const guideSegments = overlayLines
        ? [
            sampleFieldLine(overlayLines.verticalGuide[0], overlayLines.verticalGuide[1], currentViewCalibration.homography, currentViewCalibration.roi, distortionX, distortionY),
            sampleFieldLine(overlayLines.horizontalGuide[0], overlayLines.horizontalGuide[1], currentViewCalibration.homography, currentViewCalibration.roi, distortionX, distortionY),
          ].map((guide) => guide.map((point) => toCanvasPoint(point)))
            .flatMap((guide) => splitProjectedLine(guide, canvas.width, canvas.height))
        : [];

      if (edgeSegments.length > 0) {
        context.save();
        context.strokeStyle = "rgba(0, 255, 166, 0.9)";
        context.lineWidth = 2;

        for (const edge of edgeSegments) {
          context.beginPath();
          edge.forEach(([x, y], index) => {
            if (index === 0) context.moveTo(x, y);
            else context.lineTo(x, y);
          });
          context.stroke();
        }

        context.setLineDash([10, 8]);
        for (const guide of guideSegments) {
          context.beginPath();
          guide.forEach(([x, y], index) => {
            if (index === 0) context.moveTo(x, y);
            else context.lineTo(x, y);
          });
          context.stroke();
        }
        context.setLineDash([]);

        context.fillStyle = "#00ffa6";
        context.font = "bold 16px sans-serif";
        context.textAlign = "left";
        context.textBaseline = "top";
        const labelAnchor = edgeSegments[0][0];
        context.fillText("Projected field perimeter", labelAnchor[0] + 8, labelAnchor[1] + 8);
        context.restore();
      }

      if (bboxStart) {
        const [x, y] = toCanvasPoint(bboxStart);
        context.beginPath();
        context.arc(x, y, 8, 0, Math.PI * 2);
        context.fillStyle = "#ffffff";
        context.fill();
      }
    };
    image.src = imageUrl;
  }, [bboxStart, currentView, currentViewCalibration, frameCanvasSize, frameImages]);

  useEffect(() => {
    const canvas = fieldCanvasRef.current;
    if (!canvas || !currentViewCalibration) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    canvas.width = 1400;
    canvas.height = 760;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const layout = getFieldCanvasLayout(canvas.width, canvas.height, 72);
    const fieldImage = fieldImageRef.current;
    drawFieldBackground(context, layout, fieldImage, "rgba(9, 23, 20, 0.92)", "rgba(231, 245, 239, 0.45)");

    currentViewCalibration.landmarks.forEach((landmark, index) => {
      const [x, y] = fieldPointToCanvas([landmark.field_point[0], landmark.field_point[1]], layout);
      const isSelected = index === selectedLandmarkIndex;

      context.beginPath();
      context.arc(x, y, isSelected ? 15 : 11, 0, Math.PI * 2);
      context.fillStyle = LANDMARK_COLORS[index % LANDMARK_COLORS.length];
      context.fill();
      context.lineWidth = isSelected ? 4 : 2;
      context.strokeStyle = isSelected ? "#ffffff" : "rgba(255,255,255,0.82)";
      context.stroke();

      context.fillStyle = "#041014";
      context.font = "bold 14px sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(String(index + 1), x, y);
    });
  }, [currentViewCalibration, fieldImageVersion, selectedLandmarkIndex]);

  function handleCanvasClick(event: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = frameCanvasRef.current;
    const imageSize = frameImageSizes[currentView];
    if (!canvas || !currentViewCalibration || !imageSize) return;
    const rect = canvas.getBoundingClientRect();
    const mediaRect = getContainedRect(rect.width, rect.height, imageSize.width, imageSize.height);
    const mediaX = event.clientX - rect.left - mediaRect.left;
    const mediaY = event.clientY - rect.top - mediaRect.top;
    if (mediaX < 0 || mediaY < 0 || mediaX > mediaRect.width || mediaY > mediaRect.height) return;

    const displayX = (mediaX / mediaRect.width) * imageSize.width;
    const displayY = (mediaY / mediaRect.height) * imageSize.height;
    const [x, y] = distortPoint(
      [displayX, displayY],
      currentViewCalibration.roi,
      getDistortionX(currentViewCalibration),
      getDistortionY(currentViewCalibration),
    );

    if (mode === "bbox") {
      if (!bboxStart) {
        setBboxStart([x, y]);
        return;
      }

      const [startX, startY] = bboxStart;
      updateView((view) => ({
        ...view,
        roi: [Math.min(startX, x), Math.min(startY, y), Math.max(startX, x), Math.max(startY, y)],
        fallback_reason: "Manual ROI updated from captured frame.",
      }));
      setBboxStart(null);
      setMode("points");
      return;
    }

    const targetIndex = selectedLandmarkIndex;
    if (targetIndex >= currentViewCalibration.landmarks.length) return;

    updateView((view) => {
      const landmarks = view.landmarks.map((landmark, index) =>
        index === targetIndex
          ? { ...landmark, image_point: [x, y], confidence: 1 }
          : landmark,
      );
      return {
        ...view,
        landmarks,
        fallback_reason: "Manual landmark points selected from captured frame.",
      };
    });
    setPointCursor((current) => ({
      ...current,
      [currentView]: Math.max(current[currentView], Math.min(targetIndex + 1, currentViewCalibration.landmarks.length)),
    }));
    setSelectedLandmarkIndex(targetIndex);
  }

  function fieldCoordinatesFromPointer(event: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = fieldCanvasRef.current;
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
    return canvasPointToField(x, y, getFieldCanvasLayout(canvas.width, canvas.height, 72));
  }

  function canvasCoordinatesFromFieldPointer(event: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = fieldCanvasRef.current;
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    return [
      ((event.clientX - rect.left) / rect.width) * canvas.width,
      ((event.clientY - rect.top) / rect.height) * canvas.height,
    ] as [number, number];
  }

  function handleFieldPointer(
    event: React.MouseEvent<HTMLCanvasElement>,
    landmarkIndex = selectedLandmarkIndex,
    advanceSelection = true,
  ) {
    if (!currentViewCalibration) return;
    const fieldPoint = fieldCoordinatesFromPointer(event);
    if (!fieldPoint) return;
    const activeIndex = landmarkIndex;
    setFieldLandmarkPoint(activeIndex, fieldPoint);

    if (advanceSelection) {
      const nextIndex = Math.min(activeIndex + 1, currentViewCalibration.landmarks.length - 1);
      setPointCursor((current) => ({
        ...current,
        [currentView]: Math.max(current[currentView], nextIndex),
      }));
      if (activeIndex < currentViewCalibration.landmarks.length - 1) {
        setSelectedLandmarkIndex(nextIndex);
      }
    }
  }

  function handleFieldPointerStart(event: React.MouseEvent<HTMLCanvasElement>) {
    if (!currentViewCalibration) return;
    const canvas = fieldCanvasRef.current;
    const canvasPoint = canvasCoordinatesFromFieldPointer(event);
    if (!canvas || !canvasPoint) return;

    const nearestIndex = findNearestLandmarkIndex(canvasPoint, currentViewCalibration, canvas.width, canvas.height);
    draggingLandmarkIndexRef.current = nearestIndex;
    setSelectedLandmarkIndex(nearestIndex ?? selectedLandmarkIndex);
    setFieldDragging(true);
    handleFieldPointer(event, nearestIndex ?? selectedLandmarkIndex, false);
  }

  function handleFieldPointerMove(event: React.MouseEvent<HTMLCanvasElement>) {
    if (!fieldDragging) return;
    const activeIndex = draggingLandmarkIndexRef.current;
    if (activeIndex === null) return;
    handleFieldPointer(event, activeIndex, false);
  }

  function handleFieldPointerEnd() {
    setFieldDragging(false);
    draggingLandmarkIndexRef.current = null;
  }

  async function handleSave() {
    if (!calibration || !matchId) return;
    try {
      const updated = await updateCalibration(matchId, calibration);
      setCalibration(updated);
      setStatusMessage("Calibration saved to backend.");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to save calibration.");
    }
  }

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,_#071115_0%,_#111827_60%,_#081014_100%)] text-white">
      <div className="mx-auto max-w-[1600px] px-6 py-8">
        <div className="mb-8 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.35em] text-sky-300/70">Calibration Lab</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight">Capture frames and click your own ROI and landmark points.</h1>
            <p className="mt-3 max-w-3xl text-white/65">
              Scrub the match video, capture a frame for each view, select the ROI box, then click the landmark points in order. Save writes the manual calibration back to the backend.
            </p>
          </div>
          <div className="flex gap-3">
            <Link href="/" className="rounded-full border border-white/15 bg-white/8 px-5 py-3 text-sm font-medium text-white transition hover:bg-white/14">
              Back to Console
            </Link>
            <button onClick={handleSave} disabled={!calibration} className="rounded-full bg-sky-300 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-200 disabled:cursor-not-allowed disabled:bg-white/15 disabled:text-white/40">
              Save Calibration
            </button>
          </div>
        </div>

        {statusMessage ? (
          <div className="mb-6 rounded-2xl border border-sky-300/20 bg-sky-300/10 px-4 py-3 text-sm text-sky-100">
            {statusMessage}
          </div>
        ) : null}

        {!matchId || !match || !calibration || !currentViewCalibration ? (
          <div className="rounded-[32px] border border-dashed border-white/10 bg-white/5 p-10 text-center text-white/45">
            Open this page from a processed match to calibrate it.
          </div>
        ) : (
          <div className="grid gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
            <aside className="rounded-[28px] border border-white/10 bg-black/25 p-5 backdrop-blur">
              <p className="text-xs uppercase tracking-[0.28em] text-white/45">Views</p>
              <h2 className="mt-2 text-xl font-semibold">{(match.metadata.display_name as string | undefined) ?? match.id}</h2>
              <div className="mt-5 space-y-3">
                {VIEW_ORDER.map((view) => {
                  const item = calibration.views.find((entry) => entry.view === view);
                  return (
                    <button
                      key={view}
                      onClick={() => {
                        setCurrentView(view);
                        setBboxStart(null);
                        const nextView = calibration.views.find((entry) => entry.view === view);
                        const maxIndex = Math.max((nextView?.landmarks.length ?? 1) - 1, 0);
                        setSelectedLandmarkIndex(Math.min(pointCursor[view], maxIndex));
                      }}
                      className={`w-full rounded-2xl border p-4 text-left transition ${
                        currentView === view ? "border-sky-300/60 bg-sky-300/10" : "border-white/10 bg-white/5 hover:bg-white/10"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium capitalize">{view}</span>
                        <span className="text-xs text-white/50">{item?.confidence.toFixed(2)}</span>
                      </div>
                      <p className="mt-2 text-xs text-white/50">{item?.fallback_reason ?? "Manual operator override."}</p>
                    </button>
                  );
                })}
              </div>

              <div className="mt-6 space-y-3">
                <button onClick={() => setMode("bbox")} className={`w-full rounded-2xl px-4 py-3 text-sm ${mode === "bbox" ? "bg-sky-300 text-slate-950" : "border border-white/10 bg-white/5 text-white"}`}>
                  1. Draw ROI box
                </button>
                <button onClick={() => setMode("points")} className={`w-full rounded-2xl px-4 py-3 text-sm ${mode === "points" ? "bg-sky-300 text-slate-950" : "border border-white/10 bg-white/5 text-white"}`}>
                  2. Place landmarks
                </button>
                <button onClick={captureCurrentFrame} className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white hover:bg-white/10">
                  Capture frame for {currentView}
                </button>
                <button onClick={resetCurrentView} className="w-full rounded-2xl border border-rose-300/20 bg-rose-300/10 px-4 py-3 text-sm text-rose-100 hover:bg-rose-300/15">
                  Reset current view
                </button>
              </div>

              <div className="mt-6 rounded-2xl bg-white/5 p-4 text-sm text-white/65">
                <p className="font-medium text-white">Point cursor</p>
                <p className="mt-2">Next point: {Math.min(pointCursor[currentView] + 1, currentViewCalibration.landmarks.length)} / {currentViewCalibration.landmarks.length}</p>
                <p className="mt-2">Mode: <span className="text-white">{mode}</span></p>
              </div>

              <div className="mt-6 rounded-2xl bg-white/5 p-4 text-sm text-white/65">
                <div className="flex items-center justify-between">
                  <p className="font-medium text-white">X Distortion</p>
                  <span className="text-xs text-white/50">{getDistortionX(currentViewCalibration).toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={DISTORTION_SLIDER_MIN}
                  max={DISTORTION_SLIDER_MAX}
                  step={DISTORTION_SLIDER_STEP}
                  value={getDistortionX(currentViewCalibration)}
                  onChange={(event) => setDistortionX(Number(event.target.value))}
                  className="mt-3 w-full accent-sky-300"
                />
                <div className="mt-4 flex items-center justify-between">
                  <p className="font-medium text-white">Y Distortion</p>
                  <span className="text-xs text-white/50">{getDistortionY(currentViewCalibration).toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={DISTORTION_SLIDER_MIN}
                  max={DISTORTION_SLIDER_MAX}
                  step={DISTORTION_SLIDER_STEP}
                  value={getDistortionY(currentViewCalibration)}
                  onChange={(event) => setDistortionY(Number(event.target.value))}
                  className="mt-3 w-full accent-sky-300"
                />
                <p className="mt-2 text-xs text-white/45">
                  `X` tunes the side spread. `Y` tunes the top/bottom curvature, like your old distortion handler.
                </p>
              </div>
            </aside>

            <main className="grid min-w-0 gap-6">
              <section className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
                <div className="rounded-[28px] border border-white/10 bg-black/25 p-5 backdrop-blur">
                  <p className="text-xs uppercase tracking-[0.28em] text-white/45">Match Video</p>
                  <h3 className="mt-2 text-xl font-semibold">Scrub and capture</h3>
                  <div className="mt-5 grid h-[560px] grid-rows-[1fr_auto] overflow-hidden rounded-[24px] border border-white/10 bg-slate-950">
                    {playableVideoUrl ? (
                      <video
                        ref={videoRef}
                        src={playableVideoUrl ?? undefined}
                        crossOrigin="anonymous"
                        className="h-full w-full bg-black object-contain"
                        controls
                        playsInline
                        preload="metadata"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-sm text-white/45">No playable source video available for this match.</div>
                    )}
                    <div className="flex items-center gap-3 border-t border-white/10 px-4 py-3">
                      <button onClick={() => setIsPlaying((value) => !value)} className="rounded-full bg-white/10 px-4 py-2 text-sm">
                        {isPlaying ? "Pause" : "Play"}
                      </button>
                      <span className="text-sm text-white/60">{formatTime(currentTime)}</span>
                    </div>
                  </div>
                </div>

                <div className="rounded-[28px] border border-white/10 bg-black/25 p-5 backdrop-blur">
                  <p className="text-xs uppercase tracking-[0.28em] text-white/45">Captured Frame</p>
                  <h3 className="mt-2 text-xl font-semibold capitalize">{currentView} manual calibration</h3>
                  <div ref={frameCanvasContainerRef} className="relative mt-5 h-[560px] overflow-hidden border border-white/10 bg-black">
                    {frameImages[currentView] ? (
                      <canvas ref={frameCanvasRef} className="absolute inset-0 h-full w-full cursor-crosshair" onClick={handleCanvasClick} />
                    ) : (
                      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-white/45">
                        Capture a frame from the video, then click to define the ROI and landmarks.
                      </div>
                    )}
                  </div>
                </div>
              </section>

              <section className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
                <div className="rounded-[28px] border border-white/10 bg-black/25 p-5 backdrop-blur">
                  <p className="text-xs uppercase tracking-[0.28em] text-white/45">Field Target</p>
                  <h3 className="mt-2 text-xl font-semibold">Top-down reference + dynamic field points</h3>
                  <p className="mt-2 text-sm text-white/55">
                    Select a landmark on the right, then click or drag it on the field to update its field-space target. Saving will recompute the homography from those adjusted coordinates.
                  </p>
                  <div className="relative mt-5 aspect-video overflow-hidden border border-white/10 bg-[#0f1f1d]">
                    <canvas
                      ref={fieldCanvasRef}
                      className="absolute inset-0 h-full w-full cursor-crosshair"
                      onMouseDown={handleFieldPointerStart}
                      onMouseMove={handleFieldPointerMove}
                      onMouseUp={handleFieldPointerEnd}
                      onMouseLeave={handleFieldPointerEnd}
                      onClick={handleFieldPointer}
                    />
                  </div>
                </div>

                <div className="rounded-[28px] border border-white/10 bg-black/25 p-5 backdrop-blur">
                  <p className="text-xs uppercase tracking-[0.28em] text-white/45">Landmark Order</p>
                  <h3 className="mt-2 text-xl font-semibold">Click points in sequence</h3>
                  <div className="mt-5 space-y-3">
                    {currentViewCalibration.landmarks.map((landmark, index) => (
                      <button
                        type="button"
                        key={landmark.name}
                        onClick={() => setSelectedLandmarkIndex(index)}
                        className={`block w-full rounded-2xl border p-4 text-left ${selectedLandmarkIndex === index ? "border-sky-300/60 bg-sky-300/10" : pointCursor[currentView] === index ? "border-sky-300/35 bg-sky-300/5" : "border-white/10 bg-white/5"}`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium">{index + 1}. {landmark.name}</span>
                          <span className="text-xs text-white/45">field [{landmark.field_point.map((value) => value.toFixed(1)).join(", ")}]</span>
                        </div>
                        <p className="mt-2 text-xs text-white/55">image [{landmark.image_point.map((value) => value.toFixed(1)).join(", ")}]</p>
                      </button>
                    ))}
                  </div>
                </div>
              </section>
            </main>
          </div>
        )}

        <canvas ref={captureCanvasRef} className="hidden" />
      </div>
    </div>
  );
}

export default function CalibratePage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#050816]" />}>
      <CalibratePageContent />
    </Suspense>
  );
}
