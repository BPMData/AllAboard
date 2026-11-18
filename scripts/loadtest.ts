/**
 * Socket.IO load test: N fake students drawing at once, plus one teacher.
 *
 *   npx tsx scripts/loadtest.ts [--students 20] [--seconds 15] [--mode main|individual]
 *                               [--client legacy|batched] [--duty 0.4]
 *
 * The server runs in this process and the fake clients run in a forked child, so the CPU figure is the
 * server's alone. Each client simulates a 60 Hz pointer: pen down for `duty` of the time, cursor always moving.
 *   legacy  = old client: one `element-append-points` per pointer move, cursor throttled at 50 ms
 *   batched = new client: points flushed every POINT_FLUSH_MS, cursor throttled at CURSOR_EMIT_MS
 */
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as ioClient, type Socket } from 'socket.io-client';
import { CURSOR_EMIT_MS, POINT_FLUSH_MS } from '../src/lib/drawThrottle.ts';

const args = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const STUDENTS = Number(arg('students', '20'));
const SECONDS = Number(arg('seconds', '15'));
const MODE = arg('mode', 'main');
const CLIENT = arg('client', 'batched');
const DUTY = Number(arg('duty', '0.4'));
const FRAME_MS = 1000 / 60;
const STROKE_MS = 1500;

type Counts = { sentMsgs: number; sentBytes: number; recvMsgs: number; recvBytes: number };

function sizeOf(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload) ?? '');
}

function waitFor<T = any>(socket: Socket, event: string, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    socket.once(event, (d: T) => {
      clearTimeout(t);
      resolve(d);
    });
  });
}

async function join(port: number, roomId: string, userId: string, name: string) {
  const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true, reconnection: false });
  await waitFor(socket, 'connect');
  const init = waitFor(socket, 'init');
  socket.emit('join-room', { roomId, userId, name, color: '#2563eb' });
  await init;
  return socket;
}

async function runClients(port: number): Promise<void> {
  const roomId = `load-${Date.now()}`;
  const teacher = await join(port, roomId, 'usr_teacher', 'Teacher');
  await new Promise((r) => teacher.emit('teacher:auth', { pin: '1234' }, r));
  const students: Socket[] = [];
  for (let i = 0; i < STUDENTS; i++) students.push(await join(port, roomId, `usr_s${i}`, `Student ${i}`));

  let boardOf: (i: number) => string = () => 'main';
  if (MODE === 'individual') {
    const synced = waitFor<any>(students[0], 'breakout-sync');
    await new Promise((r) =>
      teacher.emit('teacher:configure-breakout', { action: 'new-round', mode: 'individual', chatScope: 'board' }, r)
    );
    const { subBoards } = await synced;
    const byUser = new Map<string, string>();
    for (const sb of Object.values<any>(subBoards)) for (const u of sb.assignedUserIds) byUser.set(u, sb.id);
    boardOf = (i) => byUser.get(`usr_s${i}`) ?? 'main';
  }
  await new Promise((r) => setTimeout(r, 300)); // let setup traffic drain

  const all = [teacher, ...students];
  const recv: Counts[] = all.map(() => ({ sentMsgs: 0, sentBytes: 0, recvMsgs: 0, recvBytes: 0 }));
  all.forEach((s, i) =>
    s.onAny((_ev, payload) => {
      recv[i].recvMsgs++;
      recv[i].recvBytes += sizeOf(payload);
    })
  );
  const sent: Counts = { sentMsgs: 0, sentBytes: 0, recvMsgs: 0, recvBytes: 0 };
  const emit = (s: Socket, ev: string, payload: unknown) => {
    sent.sentMsgs++;
    sent.sentBytes += sizeOf(payload);
    s.emit(ev, payload);
  };

  const cursorMs = CLIENT === 'legacy' ? 50 : CURSOR_EMIT_MS;
  const start = Date.now();
  process.send?.({ type: 'start' });
  const timers = students.map((s, i) => {
    const boardId = boardOf(i);
    const phase = Math.random() * STROKE_MS;
    let lastCursor = 0;
    let lastFlush = 0;
    let strokeId: string | null = null;
    let pending: number[] = [];
    let n = 0;
    let x = Math.random() * 800;
    let y = Math.random() * 600;
    const flush = () => {
      if (strokeId && pending.length) emit(s, 'element-append-points', { id: strokeId, boardId, newPoints: pending });
      pending = [];
    };
    return setInterval(() => {
      const now = Date.now();
      const t = (now - start + phase) % (STROKE_MS / DUTY);
      const penDown = t < STROKE_MS;
      x += Math.random() * 6 - 3;
      y += Math.random() * 6 - 3;
      const px = Math.round(x * 10) / 10;
      const py = Math.round(y * 10) / 10;
      if (penDown && !strokeId) {
        strokeId = `el_${i}_${n++}`;
        emit(s, 'element-start', { id: strokeId, boardId, userId: `usr_s${i}`, tool: 'pen', color: '#000', strokeWidth: 3, points: [px, py] });
        lastFlush = now;
      } else if (penDown && strokeId) {
        if (CLIENT === 'legacy') emit(s, 'element-append-points', { id: strokeId, boardId, newPoints: [px, py] });
        else {
          pending.push(px, py);
          if (now - lastFlush >= POINT_FLUSH_MS) {
            lastFlush = now;
            flush();
          }
        }
      } else if (!penDown && strokeId) {
        flush();
        strokeId = null;
      }
      const due = CLIENT === 'legacy' ? now - lastCursor > cursorMs : now - lastCursor >= cursorMs;
      if (due) {
        lastCursor = now;
        emit(s, 'cursor-move', { userId: `usr_s${i}`, userName: `Student ${i}`, color: '#2563eb', boardId, x: px, y: py, tool: 'pen', isDrawing: penDown });
      }
    }, FRAME_MS);
  });

  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  timers.forEach(clearInterval);
  await new Promise((r) => setTimeout(r, 500)); // let in-flight messages land
  const elapsed = (Date.now() - start - 500) / 1000;
  const studentRecv = recv.slice(1);
  process.send?.({
    type: 'done',
    elapsed,
    sent,
    totalRecvMsgs: recv.reduce((a, c) => a + c.recvMsgs, 0),
    totalRecvBytes: recv.reduce((a, c) => a + c.recvBytes, 0),
    teacherRecvMsgs: recv[0].recvMsgs,
    studentRecvMsgsAvg: studentRecv.reduce((a, c) => a + c.recvMsgs, 0) / studentRecv.length,
  });
  all.forEach((s) => s.disconnect());
}

async function main(): Promise<void> {
  if (args.includes('--child')) {
    await runClients(Number(arg('port', '0')));
    process.exit(0);
  }
  const { startServer } = await import('../server.ts');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'allaboard-load-'));
  process.env.BACKUP_BUCKET = 'off';
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp, skipVite: true });
  const child = fork(fileURLToPath(import.meta.url), [...args, '--child', '--port', String(srv.port)], {
    execArgv: process.execArgv,
  });
  let cpu0 = process.cpuUsage();
  let lagMax = 0;
  let lagTimer: NodeJS.Timeout | undefined;
  const result = await new Promise<any>((resolve) => {
    child.on('message', (m: any) => {
      if (m.type === 'start') {
        cpu0 = process.cpuUsage();
        let last = Date.now();
        lagTimer = setInterval(() => {
          const now = Date.now();
          lagMax = Math.max(lagMax, now - last - 100);
          last = now;
        }, 100);
      } else if (m.type === 'done') resolve(m);
    });
  });
  clearInterval(lagTimer);
  const cpu = process.cpuUsage(cpu0);
  const s = result.elapsed;
  const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
  console.log(`\n=== ${STUDENTS} students + 1 teacher | mode=${MODE} | client=${CLIENT} | pen-down ${DUTY * 100}% | ${s.toFixed(1)} s ===`);
  console.log(`inbound to server   ${fmt(result.sent.sentMsgs / s)} msg/s   (${fmt((result.sent.sentMsgs / s) * 60)} /min)   ${(result.sent.sentBytes / s / 1024).toFixed(0)} KB/s`);
  console.log(`outbound from server ${fmt(result.totalRecvMsgs / s)} msg/s   (${fmt((result.totalRecvMsgs / s) * 60)} /min)   ${(result.totalRecvBytes / s / 1024).toFixed(0)} KB/s`);
  console.log(`per student receives ${fmt(result.studentRecvMsgsAvg / s)} msg/s   teacher receives ${fmt(result.teacherRecvMsgs / s)} msg/s`);
  console.log(`server CPU          ${(((cpu.user + cpu.system) / 1000 / (s * 1000)) * 100).toFixed(0)}% of one core   max event-loop lag ${lagMax} ms`);
  await srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

void main();
