import type { Express } from 'express';
import { sniffMime, type BackupMirror } from '../backupMirror.ts';
import { createReportHandler, reportBodyParser } from '../problemReportRoute.ts';
import { isValidAssetHash, type RoomStore } from '../roomStore.ts';
import type { StartServerOptions } from './types.ts';

export function registerHttpRoutes(
  app: Express,
  {
    store,
    backup,
    options,
    getRoomAvailability,
  }: {
    store: RoomStore;
    backup: BackupMirror | null;
    options: StartServerOptions;
    getRoomAvailability: (roomId?: string) => unknown;
  }
) {
  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // "Something not working?" reports → the reporting relay (problemReportRoute.ts, docs/REPORTS.md).
  app.post(
    '/api/report',
    reportBodyParser(),
    createReportHandler({
      relayUrl: options.reportRelayUrl ?? process.env.REPORT_RELAY_URL,
      relayToken: options.reportRelayToken ?? process.env.REPORT_RELAY_TOKEN,
      appVersion: process.env.K_REVISION,
      fetchImpl: options.reportFetch,
    })
  );

  app.get('/api/rooms/:roomId', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(getRoomAvailability(String(req.params.roomId || '')));
  });

  app.get('/api/assets/:hash', async (req, res) => {
    const hash = req.params.hash;
    if (!isValidAssetHash(hash)) {
      res.status(404).end();
      return;
    }
    try {
      let asset = store.getAsset(hash);
      if (!asset && backup) {
        // Cold start: the local store is empty but the backup bucket has the image.
        const bytes = await backup.readAsset(hash);
        if (bytes && store.putAsset(bytes, sniffMime(bytes)) === hash) asset = store.getAsset(hash);
      }
      if (!asset) {
        res.status(404).end();
        return;
      }
      res.setHeader('Content-Security-Policy', 'sandbox');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', asset.mime);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.end(Buffer.from(asset.bytes));
    } catch (err) {
      console.error(`Failed to serve asset ${hash}:`, err);
      res.status(500).end();
    }
  });
}
