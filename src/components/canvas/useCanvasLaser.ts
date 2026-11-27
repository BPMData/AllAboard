import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../../lib/socketContract';

type Options = {
  laserSocket: Socket<ServerToClientEvents, ClientToServerEvents> | null;
  activeBoardId: string;
  isTeacher: boolean;
  userId: string;
  activePointerIdRef: MutableRefObject<number | null>;
};

export function useCanvasLaser({ laserSocket, activeBoardId, isTeacher, userId, activePointerIdRef }: Options) {
  type LaserPoint = { x: number; y: number; userId: string; strokeId: string; time: number; id: number };
  const [laserPoints, setLaserPoints] = useState<LaserPoint[]>([]);
  const laserIdRef = useRef(0);
  const laserStrokeRef = useRef<string | null>(null);
  const lastLaserEmitRef = useRef(0);
  const [laserNow, setLaserNow] = useState(0);
  const addLaserPoint = useCallback((point: { x: number; y: number; userId: string; strokeId: string }) => {
    const time = performance.now();
    const id = ++laserIdRef.current;
    setLaserPoints((prev) => [...prev.filter((p) => time - p.time < 1200), { ...point, time, id }]);
    setLaserNow(time);
  }, []);
  useEffect(() => {
    setLaserPoints([]);
    if (laserStrokeRef.current) activePointerIdRef.current = null;
    laserStrokeRef.current = null;
    if (!laserSocket) return;
    const receive = (point: { boardId: string; x: number; y: number; userId: string; strokeId: string }) => {
      if (point.boardId === activeBoardId) addLaserPoint(point);
    };
    laserSocket.on('laser-pulse', receive);
    return () => {
      laserSocket.off('laser-pulse', receive);
    };
  }, [laserSocket, activeBoardId, addLaserPoint, activePointerIdRef]);
  const hasLaserPoints = laserPoints.length > 0;
  useEffect(() => {
    if (!hasLaserPoints) return;
    let frame = 0;
    const tick = () => {
      const now = performance.now();
      setLaserNow(now);
      setLaserPoints((prev) => prev.filter((p) => now - p.time < 1200));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [hasLaserPoints]);
  const sendLaserPoint = (world: { x: number; y: number }, force = false) => {
    if (!isTeacher || !laserStrokeRef.current) return;
    const now = performance.now();
    if (!force && now - lastLaserEmitRef.current < 35) return;
    lastLaserEmitRef.current = now;
    const point = { ...world, boardId: activeBoardId, strokeId: laserStrokeRef.current };
    addLaserPoint({ ...point, userId });
    laserSocket?.emit('laser-pulse', point);
  };

  return { laserPoints, laserNow, laserStrokeRef, sendLaserPoint };
}
