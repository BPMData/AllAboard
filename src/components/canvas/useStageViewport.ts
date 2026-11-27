import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getElementBounds
} from '../../lib/inkCore';
import { layoutPages } from '../../lib/worksheetLayout';
import {
  CanvasElement,
  RoomBackground
} from '../../types';
import { MAX_SCALE, MIN_SCALE, PAGE_GAP } from './canvasHelpers';




type Options = { elements: CanvasElement[]; background: RoomBackground | null; allGoneNoteIds: Set<string> };
export function useStageViewport({ elements, background, allGoneNoteIds }: Options) {
  const [stageScale, setStageScale] = useState(1);

  const [stagePos, setStagePos] = useState({ x: 0, y: 0 });

  const stageRef = useRef<any>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  useEffect(() => {
    const el = containerRef.current;
    const updateSize = () => {
      if (containerRef.current) {
        const w = containerRef.current.offsetWidth;
        const h = containerRef.current.offsetHeight;
        if (w > 0 && h > 0) {
          setDimensions({ width: w, height: h });
        }
      }
    };
    window.addEventListener('resize', updateSize);
    updateSize();

    let observer: ResizeObserver | null = null;
    if (el && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        updateSize();
      });
      observer.observe(el);
    }

    return () => {
      window.removeEventListener('resize', updateSize);
      observer?.disconnect();
    };
  }, []);

  const screenToWorld = useCallback(
    (sx: number, sy: number) => ({
      x: Number(((sx - stagePos.x) / stageScale).toFixed(1)),
      y: Number(((sy - stagePos.y) / stageScale).toFixed(1)),
    }),
    [stagePos.x, stagePos.y, stageScale]
  );

  const resetView = useCallback(() => {
    setStageScale(1);
    setStagePos({ x: 0, y: 0 });
  }, []);

  const fitElementsAndBackgroundInView = useCallback(
    (targetElements: CanvasElement[], targetBg: RoomBackground | null) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      if (targetBg && Array.isArray(targetBg.pages) && targetBg.pages.length > 0) {
        for (const rect of layoutPages(targetBg, PAGE_GAP)) {
          if (rect.x < minX) minX = rect.x;
          if (rect.y < minY) minY = rect.y;
          if (rect.x + rect.width > maxX) maxX = rect.x + rect.width;
          if (rect.y + rect.height > maxY) maxY = rect.y + rect.height;
        }
      }

      for (const el of targetElements) {
        if (el.tool === 'eraser' || allGoneNoteIds.has(el.id)) continue;
        const b = getElementBounds(el);
        if (!b) continue;
        const [bx1, by1, bx2, by2] = b;
        if (bx1 < minX) minX = bx1;
        if (by1 < minY) minY = by1;
        if (bx2 > maxX) maxX = bx2;
        if (by2 > maxY) maxY = by2;
      }

      if (!isFinite(minX) || !isFinite(minY)) {
        resetView();
        return;
      }

      const contentW = Math.max(100, maxX - minX);
      const contentH = Math.max(100, maxY - minY);
      const margin = 56;
      const scaleX = (dimensions.width - margin * 2) / contentW;
      const scaleY = (dimensions.height - margin * 2) / contentH;
      const nextScale = Math.min(2.0, Math.max(MIN_SCALE, Math.min(scaleX, scaleY)));

      const centerX = minX + contentW / 2;
      const centerY = minY + contentH / 2;

      setStageScale(nextScale);
      setStagePos({
        x: dimensions.width / 2 - centerX * nextScale,
        y: dimensions.height / 2 - centerY * nextScale,
      });
    },
    [dimensions.width, dimensions.height, resetView, allGoneNoteIds]
  );

  const fitAllContent = () => {
    fitElementsAndBackgroundInView(elements, background);
  };

  const handleWheel = (e: any) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;

    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    const scaleBy = 1.1;
    const oldScale = stageScale;

    const mousePointTo = {
      x: (pointer.x - stagePos.x) / oldScale,
      y: (pointer.y - stagePos.y) / oldScale,
    };

    const direction = e.evt.deltaY > 0 ? -1 : 1;
    const unclampedScale = direction > 0 ? oldScale * scaleBy : oldScale / scaleBy;
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, unclampedScale));

    const newPos = {
      x: pointer.x - mousePointTo.x * newScale,
      y: pointer.y - mousePointTo.y * newScale,
    };

    setStageScale(newScale);
    setStagePos(newPos);
  };

  const zoomStep = (multiplier: number) => {
    const oldScale = stageScale;
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldScale * multiplier));
    const centerScreen = { x: dimensions.width / 2, y: dimensions.height / 2 };
    const centerWorld = {
      x: (centerScreen.x - stagePos.x) / oldScale,
      y: (centerScreen.y - stagePos.y) / oldScale,
    };
    setStageScale(newScale);
    setStagePos({
      x: centerScreen.x - centerWorld.x * newScale,
      y: centerScreen.y - centerWorld.y * newScale,
    });
  };

  const getLocalPosFromEvent = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: clientX, y: clientY };
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }, []);
  return { stageScale, setStageScale, stagePos, setStagePos, stageRef, containerRef, dimensions, screenToWorld, resetView, fitElementsAndBackgroundInView, fitAllContent, handleWheel, zoomStep, getLocalPosFromEvent };
}
