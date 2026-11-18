/**
 * Production static files (the built `dist/`).
 *  - `dist/assets/*` names are content-hashed by Vite, so they are cached for a year (`immutable`): a returning
 *    Chromebook downloads nothing. `index.html` is `no-cache` so a deploy is picked up at once.
 *  - Text assets are gzipped once, in memory, on first request (the app JS is ~1.5 MB raw, ~450 KB gzipped).
 *    Doesn't rely on the nginx sidecar compressing, which AI Studio controls. Any failure falls back to plain files.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', // pdf.js module worker needs a JS MIME type
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

export function distRouter(distPath: string): express.Router {
  const router = express.Router();
  const assetsDir = path.join(distPath, 'assets');
  const gzipped = new Map<string, Promise<Buffer | null>>();

  const gzipOnce = (file: string): Promise<Buffer | null> => {
    let p = gzipped.get(file);
    if (!p) {
      p = fs.promises
        .readFile(file)
        .then((raw) => new Promise<Buffer | null>((ok) => zlib.gzip(raw, { level: 9 }, (err, out) => ok(err ? null : out))))
        .catch(() => null);
      gzipped.set(file, p);
    }
    return p;
  };

  router.use('/assets', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const type = TYPES[path.extname(req.path)];
    if (!type || !/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) return next();
    let file: string;
    try {
      file = path.join(assetsDir, decodeURIComponent(req.path));
    } catch {
      return next();
    }
    // Only real files inside dist/assets (no traversal, and don't cache misses for arbitrary URLs).
    if (!file.startsWith(assetsDir + path.sep) || !fs.existsSync(file)) return next();
    gzipOnce(file).then((gz) => {
      if (!gz) return next();
      res.setHeader('Content-Type', type);
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Cache-Control', IMMUTABLE);
      res.setHeader('Content-Length', String(gz.length));
      res.end(req.method === 'HEAD' ? undefined : gz);
    }, next);
  });

  router.use(
    express.static(distPath, {
      setHeaders(res, filePath) {
        if (filePath.startsWith(assetsDir + path.sep)) res.setHeader('Cache-Control', IMMUTABLE);
        else if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );

  router.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(distPath, 'index.html'));
  });

  return router;
}
