// Shared helpers for tests that drive a real server over Socket.IO.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as ioClient, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../src/lib/socketContract.ts';
type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
import { startServer } from '../server.ts';

export type ServerHandle = Awaited<ReturnType<typeof startServer>>;

export const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export function worksheet(fileName = 'w.png', dataUrl = PNG) {
  return {
    id: `ws-${fileName}`,
    fileName,
    pages: [{ dataUrl, width: 1, height: 1 }],
    x: 0,
    y: 0,
    scale: 1,
    layout: 'stack',
    opacity: 1,
  };
}

export function waitForEvent<T = any>(socket: Socket, event: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for socket event "${event}"`));
    }, timeoutMs);
    const handler = (data: T) => {
      clearTimeout(timer);
      resolve(data);
    };
    socket.once(event, handler);
  });
}

export function emitAck<T = any>(socket: Socket, event: string, payload?: any): Promise<T> {
  return new Promise((resolve) => {
    socket.emit(event, payload, (res: T) => resolve(res));
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startTestServer(dataDir?: string) {
  const dir = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'allaboard-test-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir, skipVite: true, overviewSyncMs: 100 });
  return { srv, dir };
}

/** Tracks sockets so a test's afterEach can close them all. */
export function socketPool() {
  const open: TestSocket[] = [];
  return {
    async join(
      srv: ServerHandle,
      params: { roomId: string; userId: string; name: string; color?: string; teacherPin?: string }
    ): Promise<{ socket: Socket; init: any }> {
      // Tests also send deliberately malformed wire payloads; keep the returned socket permissive.
      const socket: TestSocket = ioClient(`http://127.0.0.1:${srv.port}`, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
      });
      open.push(socket);
      await waitForEvent(socket, 'connect');
      const initPromise = waitForEvent<Parameters<ServerToClientEvents['init']>[0]>(socket, 'init');
      socket.emit('join-room', { color: '#2563eb', ...params });
      return { socket, init: await initPromise };
    },
    closeAll() {
      for (const s of open.splice(0)) if (s.connected) s.disconnect();
    },
  };
}
