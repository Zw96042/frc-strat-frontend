export const FIELD_WIDTH = 651.25;
export const FIELD_HEIGHT = 323.25;
export const FIELD_IMAGE_SRC = "/2026_No-Fuel_Transparent.png";
export const FIELD_IMAGE_SCALE_X = 1.365;
export const FIELD_IMAGE_SCALE_Y = 1.125;

export interface FieldCanvasLayout {
  scale: number;
  frameWidth: number;
  frameHeight: number;
  frameLeft: number;
  frameTop: number;
  frameRight: number;
  frameBottom: number;
  centerX: number;
  centerY: number;
  imageWidth: number;
  imageHeight: number;
  imageLeft: number;
  imageTop: number;
}

export function getFieldCanvasLayout(canvasWidth: number, canvasHeight: number, padding: number): FieldCanvasLayout {
  const scale = Math.min((canvasWidth - padding * 2) / FIELD_WIDTH, (canvasHeight - padding * 2) / FIELD_HEIGHT);
  const frameWidth = FIELD_WIDTH * scale;
  const frameHeight = FIELD_HEIGHT * scale;
  const frameLeft = (canvasWidth - frameWidth) / 2;
  const frameTop = (canvasHeight - frameHeight) / 2;
  const imageWidth = frameWidth * FIELD_IMAGE_SCALE_X;
  const imageHeight = frameHeight * FIELD_IMAGE_SCALE_Y;
  const imageLeft = frameLeft + (frameWidth - imageWidth) / 2;
  const imageTop = frameTop + (frameHeight - imageHeight) / 2;

  return {
    scale,
    frameWidth,
    frameHeight,
    frameLeft,
    frameTop,
    frameRight: frameLeft + frameWidth,
    frameBottom: frameTop + frameHeight,
    centerX: canvasWidth / 2,
    centerY: canvasHeight / 2,
    imageWidth,
    imageHeight,
    imageLeft,
    imageTop,
  };
}

export function fieldPointToCanvas(point: [number, number], layout: FieldCanvasLayout): [number, number] {
  const [x, y] = point;
  return [
    layout.centerX + x * layout.scale,
    layout.centerY - y * layout.scale,
  ];
}

export function canvasPointToField(x: number, y: number, layout: FieldCanvasLayout): [number, number] {
  const normalizedX = (x - layout.frameLeft) / layout.frameWidth;
  const normalizedY = (y - layout.frameTop) / layout.frameHeight;
  const clampedX = Math.min(Math.max(normalizedX, 0), 1);
  const clampedY = Math.min(Math.max(normalizedY, 0), 1);

  return [
    clampedX * FIELD_WIDTH - FIELD_WIDTH / 2,
    FIELD_HEIGHT / 2 - clampedY * FIELD_HEIGHT,
  ];
}

export function drawFieldBackground(
  context: CanvasRenderingContext2D,
  layout: FieldCanvasLayout,
  image: HTMLImageElement | null,
  backgroundFill: string,
  borderColor: string,
) {
  context.fillStyle = backgroundFill;
  context.fillRect(0, 0, context.canvas.width, context.canvas.height);

  if (image?.complete) {
    context.drawImage(image, layout.imageLeft, layout.imageTop, layout.imageWidth, layout.imageHeight);
  }

  context.strokeStyle = borderColor;
  context.lineWidth = 3;
  context.strokeRect(layout.frameLeft, layout.frameTop, layout.frameWidth, layout.frameHeight);
}
