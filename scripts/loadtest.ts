/**
 * Socket.IO load test: N fake students drawing at once, plus one teacher.
 *
 *   npx tsx scripts/loadtest.ts [--students 20] [--seconds 15] [--mode main|individual]
 *                               [--client legacy|batched] [--duty 0.4] [--flush-ms 500] [--cursor-ms 250]
 *                               [--url https://… ]
 *
 * The server runs in this process and the fake clients run in a forked child, so the CPU figure is the
 * server's alone.
 *
 * --url: no local server; the fake clients connect to that deployment instead (e.g. production, at a quiet time).
 * Server CPU can't be seen from here (read Cloud Run metrics and the `[load]` log line), so it reports what users
 * feel instead: connection failures and delivery delay (new strokes and cursors are stamped with their send time;
 * every client runs on this machine, so the clocks agree). Uses a random `loadtest-…` room with a random Teacher PIN,
 * and clears its board at the end. Behind an HTTPS proxy (HTTPS_PROXY), needs `npm install --no-save https-proxy-agent`.
 * Match --flush-ms / --cursor-ms to the client version the deployment is running. Each client simulates a 60 Hz pointer: pen down for `duty` of the time, cursor always moving.
 *   legacy  = old client: one `element-append-points` per pointer move, cursor throttled at 50 ms
 *   batched = new client: points flushed every POINT_FLUSH_MS, cursor throttled at CURSOR_EMIT_MS
 */
import { fork } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
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
/** How often a batched client sends queued ink (defaults to the app's POINT_FLUSH_MS). */
const FLUSH_MS = Number(arg('flush-ms', String(POINT_FLUSH_MS)));
/** How often a batched client sends its cursor (defaults to the app's CURSOR_EMIT_MS). */
const CURSOR_MS = Number(arg('cursor-ms', String(CURSOR_EMIT_MS)));
const TARGET_URL = arg('url', '');
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

/** Proxy agent for --url behind HTTPS_PROXY (socket.io's WebSocket client ignores proxy env vars). */
let proxyAgent: unknown;
async function loadProxyAgent() {
  if (!TARGET_URL || !process.env.HTTPS_PROXY) return;
  try {
    // Optional and not a dependency: a variable specifier keeps tsc (and CI) from requiring it.
    const optionalModule = 'https-proxy-agent';
    const mod: any = await import(optionalModule);
    proxyAgent = new mod.HttpsProxyAgent(process.env.HTTPS_PROXY);
  } catch {
    throw new Error('HTTPS_PROXY is set: run `npm install --no-save https-proxy-agent` first.');
  }
}

let connectFailures = 0;
let disconnects = 0;

async function join(base: string, roomId: string, userId: string, name: string) {
  const socket = ioClient(base, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    timeout: 20000,
    ...(proxyAgent ? { agent: proxyAgent as any } : {}),
  });
  try {
    await waitFor(socket, 'connect', 20000);
    const init = waitFor(socket, 'init', 20000);
    socket.emit('join-room', { roomId, userId, name, color: '#2563eb' });
    await init;
  } catch (err) {
    connectFailures++;
    socket.close();
    throw err;
  }
  socket.on('disconnect', (reason) => {
    if (reason !== 'io client disconnect') disconnects++;
  });
  return socket;
}

/** Delivery delays in ms, from send stamp to receipt. */
const strokeDelays: number[] = [];
const cursorDelays: number[] = [];
function pct(list: number[], p: number): number {
  if (list.length === 0) return NaN;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function runClients(base: string): Promise<void> {
  await loadProxyAgent();
  const roomId = TARGET_URL ? `loadtest-${Math.random().toString(36).slice(2, 8)}` : `load-${Date.now()}`;
  const pin = String(10_000_000 + Math.floor(Math.random() * 89_999_999));
  const teacher = await join(base, roomId, 'usr_teacher', 'Load Teacher');
  await new Promise((r) => teacher.emit('teacher:auth', { pin }, r));
  // Join in waves of 10 (a whole class arriving at the bell), not one long serial queue over a slow network.
  const students: Socket[] = [];
  for (let i = 0; i < STUDENTS; i += 10) {
    const wave = await Promise.allSettled(
      Array.from({ length: Math.min(10, STUDENTS - i) }, (_, k) => join(base, roomId, `usr_s${i + k}`, `Load Student ${i + k}`))
    );
    for (const r of wave) if (r.status === 'fulfilled') students.push(r.value);
  }
  if (students.length === 0) throw new Error(`no students connected (${connectFailures} failures)`);
  process.send?.({ type: 'joined', roomId, joined: students.length, failed: connectFailures });

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
    s.onAny((ev, payload) => {
      recv[i].recvMsgs++;
      recv[i].recvBytes += sizeOf(payload);
      const now = Date.now();
      if (ev === 'element-start' && typeof payload?.t === 'number') strokeDelays.push(now - payload.t);
      if (ev === 'cursors-batch') for (const c of payload?.cursors ?? []) if (typeof c?.t === 'number') cursorDelays.push(now - c.t);
      if (ev === 'cursor-move' && typeof payload?.t === 'number') cursorDelays.push(now - payload.t);
    })
  );
  const sent: Counts = { sentMsgs: 0, sentBytes: 0, recvMsgs: 0, recvBytes: 0 };
  const emit = (s: Socket, ev: string, payload: unknown) => {
    sent.sentMsgs++;
    sent.sentBytes += sizeOf(payload);
    s.emit(ev, payload);
  };

  const cursorMs = CLIENT === 'legacy' ? 50 : CURSOR_MS;
  // The fake clients' own lag: if this is high, delivery delays measure this machine, not the server.
  const clientLag = monitorEventLoopDelay({ resolution: 10 });
  clientLag.enable();
  const clientCpu0 = process.cpuUsage();
  // Probe: a separate socket outside the room asks a trivial question (check-room) twice a second. Its round trip
  // carries none of the room's traffic, so if it slows down, the server itself is busy.
  const probeDelays: number[] = [];
  const probe = TARGET_URL
    ? ioClient(base, { transports: ['websocket'], forceNew: true, reconnection: false, ...(proxyAgent ? { agent: proxyAgent as any } : {}) })
    : null;
  if (probe) await waitFor(probe, 'connect', 20000);
  const probeTimer = probe
    ? setInterval(() => {
        const t = Date.now();
        probe.emit('check-room', { roomId }, () => probeDelays.push(Date.now() - t));
      }, 500)
    : undefined;
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
        emit(s, 'element-start', { id: strokeId, boardId, userId: `usr_s${i}`, tool: 'pen', color: '#000', strokeWidth: 3, points: [px, py], t: now });
        lastFlush = now;
      } else if (penDown && strokeId) {
        if (CLIENT === 'legacy') emit(s, 'element-append-points', { id: strokeId, boardId, newPoints: [px, py] });
        else {
          pending.push(px, py);
          if (now - lastFlush >= FLUSH_MS) {
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
        emit(s, 'cursor-move', { userId: `usr_s${i}`, userName: `Student ${i}`, color: '#2563eb', boardId, x: px, y: py, tool: 'pen', isDrawing: penDown, t: now });
      }
    }, FRAME_MS);
  });

  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  timers.forEach(clearInterval);
  if (probeTimer) clearInterval(probeTimer);
  probe?.disconnect();
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
    joined: students.length,
    clientLagP99: clientLag.percentile(99) / 1e6,
    clientLagMax: clientLag.max / 1e6,
    clientCpu: (() => { const c = process.cpuUsage(clientCpu0); return (c.user + c.system) / 1000 / (Date.now() - start); })(),
    connectFailures,
    disconnects,
    stroke: { n: strokeDelays.length, p50: pct(strokeDelays, 50), p95: pct(strokeDelays, 95), max: pct(strokeDelays, 100) },
    probe: { n: probeDelays.length, p50: pct(probeDelays, 50), p95: pct(probeDelays, 95), max: pct(probeDelays, 100) },
    cursor: { n: cursorDelays.length, p50: pct(cursorDelays, 50), p95: pct(cursorDelays, 95), max: pct(cursorDelays, 100) },
  });
  if (TARGET_URL) {
    for (const b of new Set(students.map((_, i) => boardOf(i)))) teacher.emit('teacher:clear-all', { boardId: b });
    await new Promise((r) => setTimeout(r, 500));
  }
  all.forEach((s) => s.disconnect());
}

async function main(): Promise<void> {
  if (args.includes('--child')) {
    await runClients(TARGET_URL || `http://127.0.0.1:${Number(arg('port', '0'))}`);
    process.exit(0);
  }
  if (TARGET_URL) return runRemote();
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

/** --url: fake clients against a deployment. Reports what users feel; server CPU is in Cloud Run's metrics. */
async function runRemote(): Promise<void> {
  const child = fork(fileURLToPath(import.meta.url), [...args, '--child'], { execArgv: process.execArgv });
  const result = await new Promise<any>((resolve, reject) => {
    child.on('message', (m: any) => {
      if (m.type === 'joined') console.log(`room ${m.roomId}: ${m.joined} joined, ${m.failed} failed to connect`);
      else if (m.type === 'done') resolve(m);
    });
    child.on('exit', (code) => (code ? reject(new Error(`clients exited with ${code}`)) : undefined));
  });
  const s = result.elapsed;
  const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
  const ms = (d: any) => `p50 ${fmt(d.p50)} ms, p95 ${fmt(d.p95)} ms, max ${fmt(d.max)} ms (${fmt(d.n)} samples)`;
  console.log(`\n=== ${TARGET_URL} | ${result.joined}/${STUDENTS} students + 1 teacher | mode=${MODE} | pen-down ${DUTY * 100}% | ink ${FLUSH_MS} ms, cursor ${CURSOR_MS} ms | ${s.toFixed(1)} s ===`);
  console.log(`connections         ${result.connectFailures} failed to connect, ${result.disconnects} dropped during the run`);
  console.log(`fake clients        ${(result.clientCpu * 100).toFixed(0)}% of one core, own lag p99 ${fmt(result.clientLagP99)} ms, max ${fmt(result.clientLagMax)} ms (high = this machine is the bottleneck)`);
  console.log(`server probe        ${ms(result.probe)}  (idle round trip; slow = the server is busy)`);
  console.log(`new stroke delay    ${ms(result.stroke)}`);
  console.log(`cursor delay        ${ms(result.cursor)}`);
  console.log(`inbound to server   ${fmt(result.sent.sentMsgs / s)} msg/s   ${(result.sent.sentBytes / s / 1024).toFixed(0)} KB/s`);
  console.log(`outbound from server ${fmt(result.totalRecvMsgs / s)} msg/s   ${(result.totalRecvBytes / s / 1024).toFixed(0)} KB/s`);
  console.log(`per student receives ${fmt(result.studentRecvMsgsAvg / s)} msg/s   teacher receives ${fmt(result.teacherRecvMsgs / s)} msg/s`);
  process.exit(0);
}

void main();
