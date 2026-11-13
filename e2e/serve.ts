// Boots the real AllAboard server (Express + Socket.IO + Vite middleware) for Playwright,
// with room persistence pointed at a throwaway directory so test runs never touch ./data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server';

const port = Number(process.env.E2E_PORT || 3100);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allaboard-e2e-'));

await startServer({ port, host: '127.0.0.1', dataDir });
