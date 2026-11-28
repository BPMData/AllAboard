// Uses the deployment job's existing gcloud login. Only request the fields needed for the check.
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export function verifyRelease(service, revision, runtime, sha) {
  const serving = service.status?.traffic?.find((route) => route.percent === 100)?.revisionName;
  if (
    !serving ||
    serving !== service.status.latestReadyRevisionName ||
    serving !== revision.metadata?.name ||
    serving !== runtime.revision
  )
    throw new Error('Traffic, ready revision and responding instance do not match');
  if (revision.metadata?.labels?.['commit-sha'] !== sha) throw new Error('Revision commit label does not match');
  const backup = runtime.backup;
  if (runtime.writer !== 'active' || backup?.backend !== 'gcs' || backup.target !== 'bucket "gs://allaboard-data"')
    throw new Error('Waiting for the classroom writer and production backup bucket');
  if (backup.failed !== 0 || backup.overdue !== false || backup.restoreErrors !== 0)
    throw new Error('Room backup or restore is degraded');
  return serving;
}

function describe(kind, name, fields) {
  return JSON.parse(
    execFileSync(
      'gcloud',
      [
        'run',
        kind,
        'describe',
        name,
        '--region=us-east1',
        '--project=loyal-rookery-403218',
        '--format=json(' + fields + ')',
      ],
      { encoding: 'utf8', timeout: 20_000 }
    )
  );
}

async function check(sha) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Supply the full expected commit SHA');
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const service = describe('services', 'allaboard', 'status.url,status.latestReadyRevisionName,status.traffic');
      const revision = describe('revisions', service.status.latestReadyRevisionName, 'metadata.name,metadata.labels');
      const res = await fetch(new URL('/api/release', service.status.url), { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error('Release endpoint returned HTTP ' + res.status);
      console.log('Verified release', verifyRelease(service, revision, await res.json(), sha), sha);
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      console.warn(err.message);
      await delay(3000);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await check(process.argv[2]);
