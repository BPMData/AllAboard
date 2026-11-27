import { Circle, Group, Text as KonvaText, Line, Rect } from 'react-konva';
import { NOTE_FONT, NOTE_LH, getNoteFontSize } from '../../lib/inkCore';
import { STAMP_OPTIONS, getTeacherStampAppearance, getTeacherStampDimensions } from '../../lib/stamps';
import { CanvasElement } from '../../types';

import { HollowStrokeShape, SmoothStrokeShape, SprayStrokeLine } from './KonvaLayers';

interface RendererOptions {
  editingNote: { existingId: string | null } | null;
  selectionDragOffset: { dx: number; dy: number } | null;
  selectedIds: string[];
  draggingNotePreview: { id: string; dx: number; dy: number } | null;
}
export function createCanvasElementRenderer({
  editingNote,
  selectionDragOffset,
  selectedIds,
  draggingNotePreview,
}: RendererOptions) {
  const renderElement = (el: CanvasElement, goneNoteIds?: Set<string>) => {
    if (el.tool === 'text') {
      // Hide note if an eraser stroke touched it (`notesGone`) or if it is currently open in the inline note editor
      if (goneNoteIds?.has(el.id)) return null;
      if (editingNote?.existingId === el.id) return null;
    }

    const dragDx =
      selectionDragOffset && selectedIds.includes(el.id)
        ? selectionDragOffset.dx
        : draggingNotePreview && draggingNotePreview.id === el.id
          ? draggingNotePreview.dx
          : 0;
    const dragDy =
      selectionDragOffset && selectedIds.includes(el.id)
        ? selectionDragOffset.dy
        : draggingNotePreview && draggingNotePreview.id === el.id
          ? draggingNotePreview.dy
          : 0;

    const renderBase = () => {
      if (el.tool === 'stamp') {
        const teacherMeta = getTeacherStampAppearance(el.stamp, el.text, el.color);
        if (teacherMeta) {
          const dims = getTeacherStampDimensions(teacherMeta.text, el.strokeWidth);
          return (
            <Group x={el.x || 0} y={el.y || 0} rotation={teacherMeta.rotationDeg}>
              <Rect
                x={-dims.width / 2}
                y={-dims.height / 2}
                width={dims.width}
                height={dims.height}
                cornerRadius={dims.cornerRadius}
                fill={teacherMeta.fill}
                opacity={0.94}
                stroke={teacherMeta.color}
                strokeWidth={dims.borderWidth}
                shadowColor="#0f172a"
                shadowBlur={4}
                shadowOpacity={0.14}
                shadowOffsetY={1}
              />
              <Rect
                x={-dims.width / 2 + dims.innerInset}
                y={-dims.height / 2 + dims.innerInset}
                width={dims.width - dims.innerInset * 2}
                height={dims.height - dims.innerInset * 2}
                cornerRadius={Math.max(2, dims.cornerRadius - 2)}
                stroke={teacherMeta.color}
                strokeWidth={Math.max(1, dims.borderWidth * 0.4)}
                opacity={0.45}
              />
              <KonvaText
                x={-dims.width / 2}
                y={-dims.fontSize * 0.46}
                width={dims.width}
                align="center"
                text={teacherMeta.text}
                fill={teacherMeta.color}
                fontSize={dims.fontSize}
                fontFamily="Plus Jakarta Sans, sans-serif"
                fontStyle="800"
                letterSpacing={1.2}
              />
            </Group>
          );
        }

        if (el.stamp === 'username') {
          const label = el.userName || 'Student';
          const fontSize = Math.max(13, Math.round(el.strokeWidth * 1.1 + 10));
          const padX = Math.round(fontSize * 0.85);
          const badgeW = Math.max(64, Math.round(label.length * (fontSize * 0.62) + padX * 2));
          const badgeH = Math.round(fontSize * 1.85);
          return (
            <Group x={el.x || 0} y={el.y || 0}>
              <Rect
                x={-badgeW / 2}
                y={-badgeH / 2}
                width={badgeW}
                height={badgeH}
                cornerRadius={badgeH / 2}
                fill="#ffffff"
                stroke={el.color}
                strokeWidth={Math.max(2, fontSize * 0.14)}
                shadowColor="#0f172a"
                shadowBlur={4}
                shadowOpacity={0.12}
                shadowOffsetY={1}
              />
              <KonvaText
                x={-badgeW / 2}
                y={-fontSize * 0.48}
                width={badgeW}
                align="center"
                text={label}
                fill={el.color}
                fontSize={fontSize}
                fontFamily="Plus Jakarta Sans, sans-serif"
                fontStyle="700"
              />
            </Group>
          );
        }

        const stampDef = STAMP_OPTIONS.find((s) => s.kind === el.stamp) || STAMP_OPTIONS[0];
        const radius = Math.max(16, el.strokeWidth * 1.8 + 10);
        const fontSize = Math.round(radius * 1.15);
        return (
          <Group x={el.x || 0} y={el.y || 0}>
            <Circle
              radius={radius}
              fill="#ffffff"
              stroke={el.color}
              strokeWidth={Math.max(2.5, radius * 0.14)}
              shadowColor="#0f172a"
              shadowBlur={4}
              shadowOpacity={0.12}
              shadowOffsetY={1}
            />
            <KonvaText
              x={-radius}
              y={-fontSize * 0.52}
              width={radius * 2}
              align="center"
              text={stampDef.symbol}
              fill={el.color}
              fontSize={fontSize}
              fontFamily="Plus Jakarta Sans, sans-serif"
              fontStyle="700"
            />
          </Group>
        );
      }

      if (el.tool === 'rect') {
        const x = (el.width || 0) < 0 ? (el.x || 0) + (el.width || 0) : el.x || 0;
        const y = (el.height || 0) < 0 ? (el.y || 0) + (el.height || 0) : el.y || 0;
        return (
          <Rect
            x={x}
            y={y}
            width={Math.abs(el.width || 0)}
            height={Math.abs(el.height || 0)}
            stroke={el.color}
            strokeWidth={el.strokeWidth}
            cornerRadius={2}
          />
        );
      }

      if (el.tool === 'circle') {
        const radiusX = Math.abs(el.width || 0) / 2;
        const radiusY = Math.abs(el.height || 0) / 2;
        const radius = Math.max(radiusX, radiusY);
        const centerX = (el.x || 0) + (el.width || 0) / 2;
        const centerY = (el.y || 0) + (el.height || 0) / 2;
        return <Circle x={centerX} y={centerY} radius={radius} stroke={el.color} strokeWidth={el.strokeWidth} />;
      }

      if (el.tool === 'text') {
        const fontSize = getNoteFontSize(el);
        return (
          <KonvaText
            x={el.x || 0}
            y={el.y || 0}
            text={el.text || ''}
            fill={el.color}
            fontSize={fontSize}
            lineHeight={NOTE_LH}
            fontFamily={NOTE_FONT}
            fontStyle="600"
          />
        );
      }

      const pts = el.points || [];
      if (pts.length < 2) return null;

      if (el.tool === 'eraser') {
        return (
          <SmoothStrokeShape
            points={pts}
            color="#000000"
            strokeWidth={Math.max(8, el.strokeWidth * 1.5)}
            globalCompositeOperation="destination-out"
          />
        );
      }

      if (el.tool === 'spray') {
        return <SprayStrokeLine points={pts} color={el.color} strokeWidth={el.strokeWidth} />;
      }

      if (el.tool === 'highlighter') {
        return <SmoothStrokeShape points={pts} color={el.color} strokeWidth={el.strokeWidth} opacity={1} />;
      }

      if (el.tool === 'hollow') {
        return (
          <HollowStrokeShape
            points={pts}
            color={el.color}
            strokeWidth={el.strokeWidth}
            hollowWeight={el.hollowWeight || 2}
            hollowShape={el.hollowShape || 'circle'}
          />
        );
      }

      if (el.tool === 'line') {
        return <Line points={pts} stroke={el.color} strokeWidth={el.strokeWidth} lineCap="round" lineJoin="round" />;
      }

      return <SmoothStrokeShape points={pts} color={el.color} strokeWidth={el.strokeWidth} />;
    };

    const node = renderBase();
    if (!node) return null;
    return (
      <Group key={el.id} x={dragDx} y={dragDy}>
        {node}
      </Group>
    );
  };
  return renderElement;
}
