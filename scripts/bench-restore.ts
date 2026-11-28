// Fixture creation runs in a separate process so its allocations do not count toward peak restore RSS.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { BackupMirror, DirBackend } from '../backupMirror.ts';
import { RoomStore } from '../roomStore.ts';
import { createRoomPersistence } from '../server/roomPersistence.ts';

const count = Number(process.argv[2] ?? 100);
if (!Number.isSafeInteger(count) || count < 1) throw new Error('Supply a positive room count');
const root = process.argv[3];
if (root) {
  const store = new RoomStore(path.join(root, 'restored.db'));
  const mirror = new BackupMirror(new DirBackend(root), () => null);
  const persistence = createRoomPersistence({ store, backup: mirror, rooms: new Map(), legacyStoreFile: '' });
  const start = performance.now();
  await persistence.restoreFromBackup();
  const elapsedMs = Math.round(performance.now() - start);
  if (!store.loadRoom('class-' + (count - 1))) throw new Error('Fixture was not fully restored');
  console.log(
    JSON.stringify({
      rooms: count,
      strokesPerRoom: 500,
      elapsedMs,
      peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
    })
  );
  store.close();
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-restore-'));
  try {
    fs.mkdirSync(path.join(dir, 'rooms'));
    const elements = Array.from({ length: 500 }, (_, i) => ({
      id: 'stroke-' + i,
      tool: 'pen',
      color: '#123456',
      strokeWidth: 3,
      points: Array.from({ length: 96 }, (_, j) => (i * 31 + j * 17) % 1200),
      userId: 'student-' + (i % 25),
    }));
    for (let i = 0; i < count; i++) {
      const id = 'class-' + i;
      fs.writeFileSync(
        path.join(dir, 'rooms', id + '.json.gz'),
        gzipSync(JSON.stringify({ id, lastActiveAt: Date.now(), elements }))
      );
    }
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), String(count), dir], {
      stdio: 'inherit',
    });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
