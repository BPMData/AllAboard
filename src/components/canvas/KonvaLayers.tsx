import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Image as KonvaImage, Layer, Line, Rect, Shape } from 'react-konva';
import { drawHollowElementCached, traceSmoothStrokePath } from '../../lib/inkCore';
import { HollowShapeKind } from '../../types';

export function SmoothStrokeShape({
  points,
  color,
  strokeWidth,
  globalCompositeOperation = 'source-over',
  opacity = 1,
}: {
  points: number[];
  color: string;
  strokeWidth: number;
  globalCompositeOperation?: GlobalCompositeOperation;
  opacity?: number;
}) {
  // Stable draw function: a new one on every React render would make react-konva repaint the
  // whole ink layer on every mouse move, cursor update or chat message.
  const sceneFunc = useCallback(
    (ctx: any) => {
      const rawCtx = (ctx as any)._context as CanvasRenderingContext2D;
      if (!rawCtx || !points || points.length < 2) return;
      rawCtx.save();
      rawCtx.strokeStyle = color;
      rawCtx.fillStyle = color;
      rawCtx.lineWidth = strokeWidth;
      rawCtx.lineCap = 'round';
      rawCtx.lineJoin = 'round';
      const kind = traceSmoothStrokePath(rawCtx, points, strokeWidth);
      if (kind === 'dot') {
        rawCtx.fill();
      } else if (kind === 'stroke') {
        rawCtx.stroke();
      }
      rawCtx.restore();
    },
    [points, color, strokeWidth]
  );
  return (
    <Shape
      opacity={opacity}
      globalCompositeOperation={globalCompositeOperation}
      listening={false}
      perfectDrawEnabled={false}
      sceneFunc={sceneFunc}
    />
  );
}

export function HollowStrokeShape({
  points,
  color,
  strokeWidth,
  hollowWeight = 2,
  hollowShape = 'circle',
}: {
  points: number[];
  color: string;
  strokeWidth: number;
  hollowWeight?: number;
  hollowShape?: HollowShapeKind;
}) {
  // Stable draw function (see SmoothStrokeShape); the swept geometry itself is cached per stroke in inkCore.
  const sceneFunc = useCallback(
    (ctx: any) => {
      const rawCtx = (ctx as any)._context as CanvasRenderingContext2D;
      if (!rawCtx || !points || points.length < 2) return;
      drawHollowElementCached(rawCtx, points, strokeWidth, hollowWeight, color, hollowShape);
    },
    [points, strokeWidth, hollowWeight, color, hollowShape]
  );
  return <Shape listening={false} perfectDrawEnabled={false} sceneFunc={sceneFunc} />;
}

export function SprayStrokeLine({
  points,
  color,
  strokeWidth,
}: {
  points: number[];
  color: string;
  strokeWidth: number;
}) {
  const dash = useMemo(() => [1, Math.max(6, Math.round(strokeWidth * 0.9))], [strokeWidth]);
  return (
    <Line
      points={points}
      stroke={color}
      strokeWidth={strokeWidth * 1.4}
      tension={0.4}
      lineCap="round"
      lineJoin="round"
      opacity={0.45}
      dash={dash}
    />
  );
}

export const UNFOCUSED_INK_OPACITY = 0.12;

export function MultiplyHighlightLayer({
  x,
  y,
  scaleX,
  scaleY,
  screenOpacity,
  children,
}: {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  screenOpacity: number;
  children: React.ReactNode;
}) {
  const layerRef = useRef<any>(null);

  useEffect(() => {
    const domCanvas: HTMLCanvasElement | undefined = layerRef.current?.getCanvas?.()?._canvas;
    if (domCanvas) {
      domCanvas.style.mixBlendMode = 'multiply';
    }
  }, []);

  useLayerScreenOpacity(layerRef, screenOpacity);

  return (
    <Layer ref={layerRef} x={x} y={y} scaleX={scaleX} scaleY={scaleY} listening={false}>
      {children}
    </Layer>
  );
}

export function useLayerScreenOpacity(layerRef: React.RefObject<any>, screenOpacity: number) {
  useEffect(() => {
    const domCanvas: HTMLCanvasElement | undefined = layerRef.current?.getCanvas?.()?._canvas;
    if (domCanvas) {
      domCanvas.style.opacity = screenOpacity === 1 ? '' : String(screenOpacity);
    }
  }, [layerRef, screenOpacity]);
}

export function InkLayer({
  screenOpacity,
  children,
  ...layerProps
}: {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  screenOpacity: number;
  children: React.ReactNode;
}) {
  const layerRef = useRef<any>(null);
  useLayerScreenOpacity(layerRef, screenOpacity);
  return (
    <Layer ref={layerRef} {...layerProps} listening={false}>
      {children}
    </Layer>
  );
}

export function WorksheetPageNode({
  dataUrl,
  x,
  y,
  width,
  height,
  opacity,
}: {
  dataUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    let active = true;
    const imageObj = new window.Image();
    imageObj.onload = () => {
      if (active) setImg(imageObj);
    };
    imageObj.src = dataUrl;
    return () => {
      active = false;
    };
  }, [dataUrl]);

  if (!img) return null;

  return (
    <Group x={x} y={y}>
      <Rect
        x={0}
        y={0}
        width={width}
        height={height}
        fill="#ffffff"
        stroke="#cbd5e1"
        strokeWidth={1.5}
        shadowColor="#0f172a"
        shadowBlur={12}
        shadowOpacity={0.08}
        shadowOffsetY={4}
      />
      <KonvaImage image={img} x={0} y={0} width={width} height={height} opacity={opacity} />
    </Group>
  );
}
