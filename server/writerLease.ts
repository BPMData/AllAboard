// Cloud Run may overlap revisions. A GCS generation condition elects one classroom writer.
// Higher release sequences request a graceful handoff. Expiry recovers a crashed instance.
import { randomUUID } from 'node:crypto';
import { GcsBackend, GenerationConflict } from '../backupMirror.ts';

const KEY = 'coordination/classroom-writer.json';
const LEASE_MS = 30_000;
const RENEW_MS = 10_000;
interface RecordValue {
  owner: string;
  sequence: number;
  expires: number;
  requestedBy?: number;
}

export class WriterLease {
  private readonly id = randomUUID();
  private readonly bucket: GcsBackend;
  private readonly sequence: number;
  private readonly activate: () => Promise<void>;
  private readonly drain: () => Promise<void>;
  private expires = 0;
  private active = false;
  private demand = false;
  private retired = false;
  private stopped = false;
  private running?: Promise<void>;
  private timer?: NodeJS.Timeout;
  constructor(bucket: GcsBackend, sequence: number, activate: () => Promise<void>, drain: () => Promise<void>) {
    this.bucket = bucket;
    this.sequence = sequence;
    this.activate = activate;
    this.drain = drain;
  }
  writable() {
    return this.active && Date.now() < this.expires && !this.retired && !this.stopped;
  }
  state() {
    return this.writable() ? 'active' : this.retired ? 'drained' : 'waiting';
  }
  request() {
    this.demand = true;
  }
  async start() {
    this.timer = setInterval(() => {
      if (this.active || this.demand) void this.poll();
    }, 2000);
    this.timer.unref();
    await this.poll();
  }
  poll() {
    if (this.stopped || this.retired) return Promise.resolve();
    this.running ??= this.step()
      .catch((err) => {
        if (!(err instanceof GenerationConflict)) console.error('Classroom writer coordination failed:', err);
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private async read() {
    const object = await this.bucket.readVersion(KEY);
    const record: RecordValue | null = object ? JSON.parse(new TextDecoder().decode(object.bytes)) : null;
    if (
      record &&
      (typeof record.owner !== 'string' || !Number.isFinite(record.expires) || !Number.isFinite(record.sequence))
    )
      throw new Error('Invalid classroom writer record');
    return { record, generation: object?.generation ?? '0' };
  }
  private write(value: RecordValue, generation: string) {
    return this.bucket.writeVersion(
      KEY,
      new TextEncoder().encode(JSON.stringify(value)),
      'application/json',
      generation
    );
  }
  private async step() {
    const { record, generation } = await this.read();
    if (this.stopped) return;
    const now = Date.now();
    if (record?.owner === this.id && !record.requestedBy) {
      if (record.expires - now <= LEASE_MS - RENEW_MS) {
        const expires = now + LEASE_MS;
        await this.write({ ...record, expires }, generation);
        this.expires = expires;
      } else this.expires = record.expires;
    } else if (this.active || record?.owner === this.id) {
      // Freeze admission before awaiting the last queued event or backup write.
      this.retired = true;
      if (record?.owner === this.id) await this.whileOwned(this.drain);
      else await this.drain();
      await this.release();
      return;
    } else if (!record || record.expires <= now || (!record.owner && this.sequence >= record.sequence)) {
      this.expires = now + LEASE_MS;
      await this.write({ owner: this.id, sequence: this.sequence, expires: this.expires }, generation);
    } else {
      if (this.demand && this.sequence > Math.max(record.sequence, record.requestedBy ?? 0))
        await this.write({ ...record, requestedBy: this.sequence }, generation);
      return;
    }
    if (!this.active) {
      // Renew during a large restore. No clients may join until it finishes.
      await this.whileOwned(this.activate);
      this.active = true;
    }
  }
  // Large restores and final uploads can span several renewal periods. Keep the reservation
  // while they run, preserving any successor's request in the same generation-checked update.
  private async whileOwned(operation: () => Promise<void>) {
    let renewal: Promise<void> | undefined;
    const timer = setInterval(() => {
      renewal ??= (async () => {
        const { record, generation } = await this.read();
        if (record?.owner !== this.id) {
          this.expires = 0;
          return;
        }
        const expires = Date.now() + LEASE_MS;
        await this.write({ ...record, expires }, generation);
        this.expires = expires;
      })()
        .catch((err) => console.error('Classroom lease renewal failed:', err))
        .finally(() => {
          renewal = undefined;
        });
    }, RENEW_MS);
    try {
      await operation();
    } finally {
      clearInterval(timer);
      await renewal;
    }
  }
  private async release() {
    const { record, generation } = await this.read();
    if (record?.owner === this.id)
      await this.write({ owner: '', sequence: record.requestedBy ?? 0, expires: Date.now() + LEASE_MS }, generation);
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
    await this.drain();
    if (!this.retired) await this.release();
  }
}
