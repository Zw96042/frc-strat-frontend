/**
 * Field-map and air-profile drawing (ported from fuel-density-map/webui/src/App.tsx).
 * Coordinates assume the same rebuilt-field.png asset and FIELD_IMAGE_NORM_BOUNDS as the processor.
 */

import { FIELD_HEIGHT, FIELD_IMAGE_NORM_BOUNDS, FIELD_WIDTH } from "@/lib/fieldGeometry";
import type { AirProfileData, AirProfilePoint, DetectionRecord, FieldMapData, TrackRecord } from "@/lib/types";

/** Intrinsic size of rebuilt-field.png (fuel-density-map asset); fallback before image load. */
export const FUEL_FIELD_BITMAP_SIZE = { width: 3901, height: 1583 } as const;

const FIELD_FUEL_EXCLUSION_ZONES = [
  [
    { x: 0.2812, y: 0.4991 },
    { x: 0.2966, y: 0.4302 },
    { x: 0.3302, y: 0.4302 },
    { x: 0.3461, y: 0.4991 },
    { x: 0.3302, y: 0.566 },
    { x: 0.2966, y: 0.566 },
  ],
  [
    { x: 0.6178, y: 0.4991 },
    { x: 0.6337, y: 0.4302 },
    { x: 0.6675, y: 0.4302 },
    { x: 0.6834, y: 0.4991 },
    { x: 0.6675, y: 0.566 },
    { x: 0.6337, y: 0.566 },
  ],
] as const;

function clamp(value: number, min = 0, max = 1) {
  return Math.min(Math.max(value, min), max);
}

function pointInPolygon(x: number, y: number, polygon: readonly { x: number; y: number }[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersects =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function pointIsInFieldFuelExclusionZone(x: number, y: number) {
  return FIELD_FUEL_EXCLUSION_ZONES.some((polygon) => pointInPolygon(x, y, polygon));
}

/** Inset and size of an image with `object-fit: contain` within a fixed box (CSS px). */
export function computeContainedImageRect(
  containerWidth: number,
  containerHeight: number,
  imageWidth: number,
  imageHeight: number,
): { offsetX: number; offsetY: number; dw: number; dh: number } | null {
  if (!containerWidth || !containerHeight || imageWidth <= 0 || imageHeight <= 0) {
    return null;
  }
  const scale = Math.min(containerWidth / imageWidth, containerHeight / imageHeight);
  const dw = imageWidth * scale;
  const dh = imageHeight * scale;
  const offsetX = (containerWidth - dw) / 2;
  const offsetY = (containerHeight - dh) / 2;
  return { offsetX, offsetY, dw, dh };
}

const FIELD_MAP_FUEL_DOT_RADIUS_PX = 6;
const AIRBORNE_FIELD_MAP_THRESHOLD = 0.02;

/**
 * rebuilt-field.png is always landscape (wide × short). If `field-map.json` lists width/height
 * transposed, `object-fit: contain` uses the wrong aspect: fuel dots look rotated ~90° and stretched
 * while the bitmap still draws correctly once the browser uses natural dimensions — or stays wrong
 * until load. For JSON fallback only, we normalize so the longer side is always `iw` (natural
 * dimensions from the loaded image are trusted as-is).
 */
function normalizeRebuiltFieldBitmapDimensions(width: number, height: number): { iw: number; ih: number } {
  if (width <= 0 || height <= 0) {
    return { iw: width, ih: height };
  }
  if (height > width) {
    return { iw: height, ih: width };
  }
  return { iw: width, ih: height };
}

function resolveFieldBitmapSize(
  fieldImage: HTMLImageElement | null,
  fieldMapData: FieldMapData | null,
): { iw: number; ih: number } {
  const nw = fieldImage?.naturalWidth ?? 0;
  const nh = fieldImage?.naturalHeight ?? 0;
  if (nw > 0 && nh > 0) {
    return { iw: nw, ih: nh };
  }
  if (fieldMapData && fieldMapData.imageWidth > 0 && fieldMapData.imageHeight > 0) {
    return normalizeRebuiltFieldBitmapDimensions(fieldMapData.imageWidth, fieldMapData.imageHeight);
  }
  return { iw: FUEL_FIELD_BITMAP_SIZE.width, ih: FUEL_FIELD_BITMAP_SIZE.height };
}

function getFieldImageInset(
  rectWidth: number,
  rectHeight: number,
  fieldImage: HTMLImageElement | null,
  fieldMapData: FieldMapData | null,
): { offsetX: number; offsetY: number; dw: number; dh: number } | null {
  const { iw, ih } = resolveFieldBitmapSize(fieldImage, fieldMapData);
  return computeContainedImageRect(rectWidth, rectHeight, iw, ih);
}

/** Map FRC field inches (center origin, +y toward alliance wall) to normalized PNG coords used by fuel export. */
export function fieldInchesToNormFxFy(xIn: number, yIn: number): [number, number] {
  const nx = (xIn + FIELD_WIDTH / 2) / FIELD_WIDTH;
  const ny = (FIELD_HEIGHT / 2 - yIn) / FIELD_HEIGHT;
  const nxC = clamp(nx, 0, 1);
  const nyC = clamp(ny, 0, 1);
  const { minX, maxX, minY, maxY } = FIELD_IMAGE_NORM_BOUNDS;
  const fx = minX + nxC * (maxX - minX);
  const fy = minY + nyC * (maxY - minY);
  return [fx, fy];
}

export function fieldInchesToCanvasXY(
  xIn: number,
  yIn: number,
  inset: { offsetX: number; offsetY: number; dw: number; dh: number },
): [number, number] {
  const [fx, fy] = fieldInchesToNormFxFy(xIn, yIn);
  return [inset.offsetX + fx * inset.dw, inset.offsetY + fy * inset.dh];
}

function drawFieldBaseAndParticles(
  context: CanvasRenderingContext2D,
  rect: DOMRect,
  fieldImage: HTMLImageElement | null,
  fieldMapData: FieldMapData | null,
  airProfileData: AirProfileData | null,
  frameIndex: number,
) {
  const inset = getFieldImageInset(rect.width, rect.height, fieldImage, fieldMapData);

  if (!inset) {
    context.fillStyle = "#0a0c10";
    context.fillRect(0, 0, rect.width, rect.height);
    return;
  }

  if (fieldImage?.complete && fieldImage.naturalWidth > 0) {
    context.drawImage(fieldImage, inset.offsetX, inset.offsetY, inset.dw, inset.dh);
  } else {
    context.fillStyle = "#0a0c10";
    context.fillRect(0, 0, rect.width, rect.height);
    context.strokeStyle = "rgba(255,255,255,0.06)";
    context.strokeRect(inset.offsetX + 0.5, inset.offsetY + 0.5, inset.dw - 1, inset.dh - 1);
  }

  if (!fieldMapData?.frames?.length) {
    return;
  }

  const maxFrameIndex = Math.max(fieldMapData.frames.length - 1, 0);
  const activeFrame = fieldMapData.frames[Math.min(frameIndex, maxFrameIndex)] ?? [];
  const airFrameMaxIndex = Math.max((airProfileData?.frames.length ?? 0) - 1, 0);
  const activeAirFrame = airProfileData?.frames[Math.min(frameIndex, airFrameMaxIndex)] ?? [];
  const hasAlignedAirFrame = activeAirFrame.length === activeFrame.length;

  const baseRadius = FIELD_MAP_FUEL_DOT_RADIUS_PX;
  for (let pointIndex = 0; pointIndex < activeFrame.length; pointIndex += 1) {
    const pt = activeFrame[pointIndex];
    const normalizedX = pt[0] ?? 0;
    const normalizedY = pt[1] ?? 0;
    const nz = pt.length > 2 ? pt[2] ?? 0 : 0;
    let airborneHeightNorm = 0;
    if (hasAlignedAirFrame) {
      airborneHeightNorm = clamp((activeAirFrame[pointIndex]?.[1] ?? 0) / 10000);
    } else if (pt.length > 2) {
      airborneHeightNorm = clamp(nz / 10000);
    }
    const isAirborne = airborneHeightNorm >= AIRBORNE_FIELD_MAP_THRESHOLD;
    const markerRadius = isAirborne ? baseRadius * (0.72 + airborneHeightNorm * 1.1) : baseRadius;
    let fx = normalizedX / 10000;
    let fy = normalizedY / 10000;
    fx = clamp(fx, FIELD_IMAGE_NORM_BOUNDS.minX, FIELD_IMAGE_NORM_BOUNDS.maxX);
    fy = clamp(fy, FIELD_IMAGE_NORM_BOUNDS.minY, FIELD_IMAGE_NORM_BOUNDS.maxY);
    if (pointIsInFieldFuelExclusionZone(fx, fy)) {
      continue;
    }

    const { offsetX, offsetY, dw, dh } = inset;
    let x = offsetX + fx * dw;
    let y = offsetY + fy * dh;
    x = clamp(x, offsetX + markerRadius, offsetX + dw - markerRadius);
    y = clamp(y, offsetY + markerRadius, offsetY + dh - markerRadius);

    const glow = context.createRadialGradient(x, y, markerRadius * 0.2, x, y, markerRadius * 2.8);
    if (isAirborne) {
      glow.addColorStop(0, "rgba(211, 162, 255, 0.76)");
      glow.addColorStop(0.48, "rgba(148, 87, 255, 0.42)");
      glow.addColorStop(1, "rgba(112, 44, 255, 0)");
    } else {
      glow.addColorStop(0, "rgba(255, 232, 110, 0.62)");
      glow.addColorStop(0.45, "rgba(245, 212, 62, 0.34)");
      glow.addColorStop(1, "rgba(245, 212, 62, 0)");
    }

    context.beginPath();
    context.arc(x, y, markerRadius * 2.8, 0, Math.PI * 2);
    context.fillStyle = glow;
    context.fill();

    context.beginPath();
    context.arc(x, y, markerRadius, 0, Math.PI * 2);
    context.fillStyle = isAirborne ? "rgba(138, 76, 255, 0.98)" : "rgba(224, 175, 34, 0.96)";
    context.shadowColor = isAirborne ? "rgba(176, 112, 255, 0.42)" : "rgba(245, 212, 62, 0.32)";
    context.shadowBlur = markerRadius * (isAirborne ? 1.25 : 0.95);
    context.fill();
  }

  context.shadowBlur = 0;
}

export interface CombinedFieldRobotInput {
  labels: Record<string, string>;
  selectedTrackId: number | null;
  heatmapTracks: Array<{ x: number; y: number }>;
  visibleDetections: DetectionRecord[];
  visibleTrackHistory: Map<number, TrackRecord[]>;
  visibleTracksOnMap: TrackRecord[];
}

export function drawCombinedFieldFrame(
  canvas: HTMLCanvasElement,
  fieldImage: HTMLImageElement | null,
  fieldMapData: FieldMapData | null,
  airProfileData: AirProfileData | null,
  fuelFrameIndex: number,
  robots: CombinedFieldRobotInput,
) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return;
  }

  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const devicePixelRatio = window.devicePixelRatio || 1;
  const width = Math.round(rect.width * devicePixelRatio);
  const height = Math.round(rect.height * devicePixelRatio);

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);

  drawFieldBaseAndParticles(context, rect, fieldImage, fieldMapData, airProfileData, fuelFrameIndex);

  const inset = getFieldImageInset(rect.width, rect.height, fieldImage, fieldMapData);
  if (!inset) {
    return;
  }

  const { labels, selectedTrackId, heatmapTracks, visibleDetections, visibleTrackHistory, visibleTracksOnMap } = robots;

  heatmapTracks.forEach((track) => {
    const [x, y] = fieldInchesToCanvasXY(track.x, track.y, inset);
    const gradient = context.createRadialGradient(x, y, 0, x, y, 26);
    gradient.addColorStop(0, "rgba(59, 142, 234, 0.38)");
    gradient.addColorStop(1, "rgba(59, 142, 234, 0)");
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(x, y, 26, 0, Math.PI * 2);
    context.fill();
  });

  visibleDetections.forEach((detection) => {
    const [x, y] = fieldInchesToCanvasXY(detection.field_point[0], detection.field_point[1], inset);
    context.beginPath();
    context.arc(x, y, 7, 0, Math.PI * 2);
    context.fillStyle = "rgba(224, 231, 239, 0.9)";
    context.fill();
    context.strokeStyle = "rgba(255, 255, 255, 0.85)";
    context.lineWidth = 1.25;
    context.stroke();
  });

  for (const trail of visibleTrackHistory.values()) {
    const sorted = [...trail].sort((a, b) => a.time - b.time);
    if (sorted.length < 2) continue;
    context.beginPath();
    sorted.forEach((point, index) => {
      const [x, y] = fieldInchesToCanvasXY(point.x, point.y, inset);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.strokeStyle = "rgba(147, 197, 253, 0.35)";
    context.lineWidth = 2.5;
    context.stroke();
  }

  visibleTracksOnMap.forEach((track) => {
    const [x, y] = fieldInchesToCanvasXY(track.x, track.y, inset);
    const label = labels[String(track.track_id)] ?? `T${track.track_id}`;
    const selected = selectedTrackId === track.track_id;

    context.fillStyle = selected ? "#f1f5f9" : "#cbd5e1";
    context.strokeStyle = selected ? "#60a5fa" : "#e2e8f0";
    context.lineWidth = selected ? 3 : 1.5;
    context.beginPath();
    context.roundRect(x - 17, y - 17, 34, 34, 7);
    context.fill();
    context.stroke();

    context.fillStyle = "#0f172a";
    context.font = "bold 11px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label.slice(0, 5), x, y);
  });
}

export function drawFieldMapFrame(
  canvas: HTMLCanvasElement,
  fieldMapData: FieldMapData,
  airProfileData: AirProfileData | null,
  frameIndex: number,
  fieldImage: HTMLImageElement | null,
) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return;
  }

  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const devicePixelRatio = window.devicePixelRatio || 1;
  const w = Math.round(rect.width * devicePixelRatio);
  const h = Math.round(rect.height * devicePixelRatio);

  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);

  drawFieldBaseAndParticles(context, rect, fieldImage, fieldMapData, airProfileData, frameIndex);
}

/**
 * When the backend does not ship `air_profile.json`, fuel points in `field-map.json` may still
 * carry a third component (0–10000) used as relative height — same encoding as air profile.
 */
export function airProfileFromFieldMap(fieldMapData: FieldMapData | null): AirProfileData | null {
  if (!fieldMapData?.frames?.length) {
    return null;
  }
  return {
    fps: fieldMapData.fps,
    frameCount: fieldMapData.frameCount,
    frames: fieldMapData.frames.map((pts) =>
      pts.map((p) => {
        const x = p[0] ?? 0;
        const z = p.length > 2 ? p[2] ?? 0 : 0;
        return [x, z] as AirProfilePoint;
      }),
    ),
  };
}

function airProfileBandCenter(relativeHeight: number) {
  if (relativeHeight >= 0.66) {
    return 0.14;
  }
  if (relativeHeight >= 0.33) {
    return 0.39;
  }
  if (relativeHeight >= 0.02) {
    return 0.64;
  }
  return 0.88;
}

export function drawAirProfileFrame(canvas: HTMLCanvasElement, airProfileData: AirProfileData, frameIndex: number) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return;
  }

  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(rect.width * dpr);
  const height = Math.round(rect.height * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);

  const pad = { top: 10, right: 12, bottom: 12, left: 12 };
  const plotW = rect.width - pad.left - pad.right;
  const plotH = rect.height - pad.top - pad.bottom;
  if (plotW <= 0 || plotH <= 0) {
    return;
  }

  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + (plotH / 4) * i;
    context.beginPath();
    context.moveTo(pad.left, y);
    context.lineTo(pad.left + plotW, y);
    context.strokeStyle = "rgba(255,255,255,0.08)";
    context.lineWidth = 1;
    context.stroke();
  }

  const frames = airProfileData.frames ?? [];
  const activeFrame = frames[Math.min(frameIndex, Math.max(0, frames.length - 1))] ?? [];
  for (const [depth, heightNormRaw] of activeFrame) {
    const depthNorm = clamp(depth / 10000);
    const heightNorm = clamp(heightNormRaw / 10000);
    const x = pad.left + depthNorm * plotW;
    const y = pad.top + airProfileBandCenter(heightNorm) * plotH;

    const glow = context.createRadialGradient(x, y, 0, x, y, 12);
    glow.addColorStop(0, "rgba(255, 226, 122, 0.9)");
    glow.addColorStop(0.55, "rgba(242, 193, 54, 0.35)");
    glow.addColorStop(1, "rgba(242, 193, 54, 0)");
    context.fillStyle = glow;
    context.beginPath();
    context.arc(x, y, 12, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = "rgba(241, 194, 61, 0.98)";
    context.beginPath();
    context.arc(x, y, 4.5, 0, Math.PI * 2);
    context.fill();
  }
}

export async function fetchJsonFieldMap(url: string): Promise<FieldMapData> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Field map request failed (${response.status})`);
  }
  return response.json() as Promise<FieldMapData>;
}

export async function fetchJsonAirProfile(url: string): Promise<AirProfileData> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Air profile request failed (${response.status})`);
  }
  return response.json() as Promise<AirProfileData>;
}
