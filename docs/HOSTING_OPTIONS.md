# Hosting options (DRAFT: nothing decided)

> **Status: undecided. No decision has been made, nothing here is approved, and nothing here has been built.**
> This file is an archive of a discussion (21 Nov 2026) so it can be picked up later without starting over. The VM
> sketch in §5 is the option that looked most promising that day, written down in detail so it can be judged. It's
> **not a plan of record**. Until the owner says otherwise, production stays on Cloud Run exactly as
> [`DEPLOYMENT.md`](DEPLOYMENT.md) describes, and its rules still apply.
>
> Prices below were looked up on 21 Nov 2026 from third-party aggregators, not Google's own page. **Check them in
> Google's pricing calculator before relying on them.**

## 1. Why this came up

- Cloud Run felt like the wrong fit. It's built for short, stateless requests. AllAboard (Socket.IO) and OverHeard
  (Server-Sent Events) hold long-lived connections and keep room state in memory, with max instances = 1.
- Pain points: the disk is wiped on every cold start and redeploy, cold starts happen after ~15 min idle, and, as it
  turned out, two default settings were capping capacity (next section).
- Context: the owner is in the US East now. The apps are partly a portfolio for teaching jobs abroad (possibly China
  later). China-specific hosting is deliberately **deferred** (§8).

## 2. What already changed (PR #48), and why it may be enough

PR #48 (capacity + hardening) fixed the two settings that were actually capping capacity:

- `--concurrency 1000`. The default 80 capped the whole service at ~80 open tabs, since each tab's WebSocket is one
  in-flight request.
- `--timeout 3600`. The default 300 s cut every socket every 5 minutes, forcing a full re-join.

It also added server-side cursor batching, per-socket rate limits and size caps, hashed Teacher PINs, and a
once-a-minute `[load]` log line (sockets, peak, busiest room, event-loop lag, RSS, rate-limited count).

**Suggested first step, whatever is chosen later:** run real classes on Cloud Run after #48 and read the `[load]` lines
(`gcloud logging read 'textPayload:"[load]"' --limit 50`). If the only remaining annoyance is cold starts, option B in
§4 may be all that's needed.

## 3. Measured load (scripts/loadtest.ts, after #48)

Measured in a 4-core dev container, not on Cloud Run or a VM. Treat CPU as relative. "Ink 50 ms" is how #48 first
shipped; "ink 500 ms" is the current setting (`POINT_FLUSH_MS`: other people's strokes arrive twice a second, your own
always draws instantly).

| Scenario                                  | CPU, ink 50 ms | CPU, ink 500 ms | Msgs to each student/s (50 → 500 ms) | Server outbound      |
| ----------------------------------------- | -------------- | --------------- | ------------------------------------ | -------------------- |
| 30 students, one main board, pen down 15% | ~8–10%         | ~5%             | 84 → 24                              | ~1.2 MB/s (~10 Mbps) |
| 30 students, one main board, pen down 40% | ~10%           | ~7%             | 196 → 41                             | ~1.3 MB/s            |
| 90 students, one main board, pen down 40% | ~37–45%        | ~15%            | 615 → 108                            | ~12 MB/s (~100 Mbps) |
| 200 students, individual breakouts        | ~15%           | ~15%            | ~0                                   | ~0.4 MB/s            |

Flush-rate sweep (90 students, pen down 40%): 50 ms → 45% CPU, 333 ms → 18%, 500 ms → 15%, 1000 ms → 14%. Past 500 ms
the remaining cost is cursors and the per-stroke `element-start`. Cursors were then cut from 10/s to 4/s
(`CURSOR_EMIT_MS` 250 ms): 30 students pen 15% → ~3% CPU, 18 msgs/s per student; 90 students pen 40% → ~12%, 101/s.
The capacity table below wasn't raised for this; treat it as conservative.

Takeaways:

- **Each app is one Node process, so it uses at most one core**, whatever the machine has. AllAboard can't be spread
  across cores or instances because its room state is in memory. More cores only help to run several apps side by
  side, unless rooms are split across processes (§3.2).
- **Bandwidth is roughly the same at any ink rate** (same strokes, fewer, bigger messages). It's what costs money and
  what rules out home hosting. A busy 45-minute class on one shared board is roughly 1.2 MB/s × 2,700 s ≈ 3.3 GB out.
  OverHeard is far lighter.

### 3.1 Rough capacity before it starts to stutter (estimates, ±2×)

Assumptions: a Google E2 vCPU is about half as fast as the test container's cores, so measured CPU is doubled. "Starts
to feel bad" ≈ 60% of a core, when event-loop lag climbs (ink trailing behind, jumpy cursors, slow joins). `e2-medium`
sustains about one core in total, shared with OverHeard and the OS. `e2-standard-2` lets AllAboard have a full core to
itself. Memory and network bandwidth aren't the limit on either machine.

| Usage (classes of 30), ink 500 ms            | `e2-medium` (shared with OverHeard) | `e2-standard-2` |
| -------------------------------------------- | ----------------------------------- | --------------- |
| Everyone drawing on their class's main board | ~4–5 classes                        | ~5–6 classes    |
| Typical mix (main board + breakouts)         | ~6 classes                          | ~8 classes      |
| All in individual or group breakouts         | ~300 students                       | ~400 students   |
| One giant shared board (single room)         | ~100+ students                      | ~120+ students  |

- On a giant shared board, **students' Chromebooks are the more likely limit** (each one draws everyone's ink). At
  500 ms they get ~108 messages/s at 90 students instead of ~615.
- OverHeard (not load-tested): streams text and translates via outside services. Expect hundreds of listeners; its own
  caps (200 per room, 100 rooms) probably bind first.
- Check against reality with the `[load]` log line: a steady `lagP99Ms` over ~50 ms during class means it's close.

### 3.1a Production stress test (21 Nov 2026, Cloud Run, after #48 and after #50)

Run with `scripts/loadtest.ts --url https://allaboard-606573080592.us-east1.run.app` at 10:30 pm on a Friday (no
classes), 40–60 s per step, pen down 15% unless noted. Fake students all ran in one cloud container (not on school
Wi-Fi), so absolute delays are better than a classroom's; the before/after comparison is what matters. "Probe" is a
separate socket outside the rooms asking a trivial question twice a second: when it slows down, the server is busy.
No step had a failed or dropped connection.

| Step                      | Before #50 (ink 20/s, cursors 10/s): new stroke delay typical / slowest 5% / worst; probe slowest 5% | After #50 (ink 2/s, cursors 4/s)                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1 class of 30             | 39 / 71 / 91 ms; probe fine                                                                          | 40 / 62 / 77 ms; probe 41 ms                                            |
| 1 board with 60           | 84–92 / 830–930 / 2,860 ms; probe 0.8–1.6 s (**overloaded**)                                         | 41 / 138 / 174 ms; probe 42 ms                                          |
| 2 classes at once         | 40 / 65–122 / 219 ms; rare 0.3 s probe blips                                                         | 39 / 55–59 / 88 ms; probe 43 ms                                         |
| 3 classes at once         | 45–59 / 285–477 / 1,341 ms; probe ~0.5 s (**straining**)                                             | 39 / 63–84 / 110 ms; probe ≤ 48 ms                                      |
| 5 classes at once         | not run                                                                                              | 40 / 63–76 / 106 ms; probe ≤ 50 ms                                      |
| 5 classes, pen down 40%   | not run                                                                                              | 40 / 64–81 / 262 ms; probe ≤ 57 ms                                      |
| 10 classes (300 students) | not run                                                                                              | 39–43 / 58–115 / 204 ms; probe ≤ 65 ms                                  |
| 15 classes (450 students) | not run                                                                                              | 41–56 / 67–136 / 209 ms; probe 79–251 ms (first strain)                 |
| 20 classes (600 students) | not run                                                                                              | 42–101 / 70–288 / 698 ms; probe 135–234 ms (clear strain, still usable) |

Takeaway: on today's Cloud Run (1 instance), the comfortable limit went from **~2 classes to ~10–15 classes at once**.
Strain starts around 15 and is clear by 20, which is far beyond one teacher or a department. The §3.1 estimates were
too conservative after #50, and too optimistic before it.

### 3.2 If more is ever needed (not planned)

- Cheap knobs are mostly used up: ink is at 2/s and cursors at 4/s. Going lower saves little (see the sweep above).
- **Split rooms across processes:** rooms never interact, so one AllAboard process per core, with the proxy routing
  each room code to the same process, scales with cores (`e2-standard-2` ≈ 2×, `e2-standard-4` ≈ 4×) without a shared
  database. Needs the room code in the connection URL and one SQLite file per process.
- From-scratch alternatives discussed: `uWebSockets.js` + binary point encoding instead of Socket.IO + JSON; a hosted
  room-per-object platform (Cloudflare Durable Objects / PartyKit); CRDTs (Yjs), rejected because teacher authority
  (locks, ownership) needs a server that understands what it relays.

## 4. Options considered

|       | Option                                                          | Good                                                                                                                                                   | Bad                                                                                                                                                                                                               | Rough cost                           |
| ----- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **A** | **Stay on Cloud Run as is (after #48)**                         | Nothing to do. Google handles restarts, TLS, OS.                                                                                                       | Cold starts; disk wiped (the bucket backup covers it); deploys cut live sockets.                                                                                                                                  | Current bill                         |
| **B** | **Cloud Run + `--min-instances 1`**                             | One flag. No cold starts.                                                                                                                              | Pays for an always-on instance; disk still wiped.                                                                                                                                                                 | **Unverified**, check the calculator |
| **C** | **Compute Engine VM** (sketch in §5)                            | A normal Linux box: disk persists, no cold starts, no request caps. Same project, bucket and billing. AllAboard's bucket backup should work unchanged. | You own OS updates, firewall, TLS (Caddy), restarts (systemd), monitoring.                                                                                                                                        | `e2-medium` ≈ $24/mo (§6)            |
| **D** | **VPS elsewhere** (Hetzner Ashburn, DigitalOcean NYC, Vultr NJ) | Often cheaper, with large bandwidth allowances included.                                                                                               | Same ops work as C, plus: `GcsBackend` gets its token from Google's metadata server, which a non-Google VM doesn't have, so the bucket backup needs new login code (or switch to `DirBackend` + an off-box sync). | Check current prices                 |
| **E** | **Home laptop** (e.g. Cloudflare Tunnel)                        | Free, fun experiment.                                                                                                                                  | Rejected for live classes: home upload bandwidth (~10 Mbps per busy class), possible CGNAT, sleep/updates, one residential line as the single point of failure.                                                   | $0                                   |

Leaning that day: **C** if moving at all, because it's the least change from today (same project, same bucket, same
deploy secret) and the least "cloud-like" option. **A or B** remain perfectly reasonable if #48 turns out to be enough.

## 5. Sketch: one Compute Engine VM for AllAboard + OverHeard (NOT approved)

```
Compute Engine VM (us-east1, e2-medium to start), static external IP
  └── Caddy (auto HTTPS, reverse proxy)            ports 80/443 open
        ├── allaboard.<domain>  → node :3002  (systemd: allaboard.service)
        └── overheard.<domain>  → node :3001  (systemd: overheard.service)
  persistent disk: /var/lib/allaboard (SQLite), /srv/allaboard, /srv/overheard
  AllAboard backups → gs://allaboard-data (unchanged, via the VM's service account)
```

- **Separate processes, shared machine.** One app crashing or deploying must not take the other down.
- **Subdomains, not path prefixes**, so the Vite builds' absolute asset paths keep working.
- A domain is needed (any registrar). Point A records at the static IP.

### 5.1 AllAboard config: no code changes expected

The existing env switches already cover a VM (`server.ts`, `openBackupMirror`, `startServer`):

```ini
# /etc/allaboard.env
NODE_ENV=production
PORT=3002
DATA_DIR=/var/lib/allaboard
BACKUP_BUCKET=allaboard-data   # must be explicit: the automatic default only applies when K_SERVICE (Cloud Run) is set
```

- `GcsBackend` gets its token from `metadata.google.internal`, which Compute Engine VMs also have. The VM's service
  account needs write access to the bucket (e.g. `roles/storage.objectAdmin` on `allaboard-data`) and the VM's access
  scopes must allow Storage (`cloud-platform` or `devstorage.read_write`). **Verify with the boot log line
  `Backing up rooms to ...`.**
- Boot still restores from the bucket, but it skips rooms whose local copy is newer, so a persistent disk is safe.
- ⚠️ **Never run two servers against the same bucket at once** (e.g. the VM while Cloud Run is still live). They'd
  overwrite each other's room backups. Test the VM with `BACKUP_BUCKET=off` or a scratch bucket.

### 5.2 OverHeard config

```ini
# /etc/overheard.env  (chmod 600, root-owned: holds a secret)
NODE_ENV=production
PORT=3001
TRUST_PROXY_HOPS=1             # Caddy is the one proxy in front, as Cloud Run's front end was
GOOGLE_TRANSLATE_API_KEY=...   # if used today; copy from the current Cloud Run settings
```

- OverHeard rooms are in memory by design. Nothing to migrate.
- **Student short links:** `OverHeard/deploy/github-pages-404.html` forwards `bpmdata.github.io/<room>` to the
  `over-heard-…run.app` URL. Update it at cut-over.

### 5.3 Caddy

```caddyfile
# /etc/caddy/Caddyfile
allaboard.example.org {
    reverse_proxy localhost:3002
}
overheard.example.org {
    reverse_proxy localhost:3001 {
        flush_interval -1      # stream SSE events immediately
    }
}
```

Caddy proxies WebSockets with no extra config and gets and renews certificates itself.

### 5.4 systemd (one unit per app)

```ini
# /etc/systemd/system/allaboard.service
[Unit]
Description=AllAboard
After=network-online.target

[Service]
WorkingDirectory=/srv/allaboard
EnvironmentFile=/etc/allaboard.env
ExecStart=/usr/bin/node server.ts
Restart=always
RestartSec=2
User=allaboard
KillSignal=SIGTERM
TimeoutStopSec=30              # time for the SIGTERM flush to SQLite + bucket to finish
MemoryMax=1500M

[Install]
WantedBy=multi-user.target
```

The OverHeard unit is the same shape, with its own user, directory and env file. Its start command comes from its
`package.json`. Both apps need Node 22 (`engines`).

### 5.5 Deploy (GitHub Actions, replacing `gcloud run deploy`)

Sketch: on merge to `main`, run the existing checks, then
`gcloud compute ssh <vm> --command "cd /srv/allaboard && git pull && npm ci && npm run build && sudo systemctl restart allaboard"`,
using the same Workload Identity Federation login as `deploy.yml` (`github-deployer` would need Compute permissions). A restart still cuts live sockets for a few
seconds, as a Cloud Run deploy does today; clients reconnect on their own.

### 5.6 Ops checklist (what Cloud Run did for us)

- [ ] Reserve a static external IP; firewall: only 22 (ideally via IAP), 80 and 443 open
- [ ] `unattended-upgrades` for security patches
- [ ] An outside uptime check (Cloud Monitoring uptime check, or any free pinger) hitting `/healthz`
- [ ] Scheduled persistent-disk snapshots (second backup of SQLite on top of the bucket)
- [ ] Logs: `journalctl -u allaboard`; optionally install the Ops Agent to keep `gcloud logging read` working
- [ ] Rewrite `DEPLOYMENT.md`, `CLAUDE.md` (its "non-negotiables" are Cloud Run specific) and `ARCHITECTURE.md` §4

### 5.7 Cut-over and rollback (if ever chosen)

1. Build the VM next to Cloud Run. Test with `BACKUP_BUCKET=off` on the VM.
2. In a quiet window: stop writes on Cloud Run (or accept losing ≤ 10 s), flush, point the VM at `allaboard-data`,
   start it (it restores from the bucket), switch DNS / links.
3. Rollback: point links back at the `run.app` URL. Cloud Run restores from the same bucket on its next cold start.
   Keep the Cloud Run service (scaled to zero) for a few weeks.

## 6. Compute Engine prices (looked up 21 Nov 2026, from aggregators; verify)

There's no `e2-large`. After `e2-medium`, the next step up is `e2-standard-2`.

| Machine         | vCPU / RAM           | On demand | ≈ per month (730 h) | 1-yr commit | 3-yr commit |
| --------------- | -------------------- | --------- | ------------------- | ----------- | ----------- |
| `e2-medium`     | 2 shared vCPU / 4 GB | $0.0335/h | **≈ $24.46**        | ≈ $15.41/mo | ≈ $11.01/mo |
| `e2-standard-2` | 2 vCPU / 8 GB        | $0.0670/h | **≈ $48.92**        | ≈ $30.82/mo | ≈ $22.01/mo |

- `e2-medium` is a **shared-core** type: 2 vCPUs that together sustain about one core, with bursts. Given one core
  per app and the load numbers in §3, it's likely enough for both apps. `e2-standard-2` gives 2 full vCPUs and 8 GB.
- E2 types don't get sustained-use discounts; the committed-use prices above require a 1- or 3-year commitment.
- **Not included:** boot disk (a few dollars for 20–30 GB), in-use static IPv4 address (Google charges for these),
  snapshots, and **internet egress**. Egress is reportedly **≈ $0.12/GiB** for the first TiB (Premium tier, to
  confirm). Using §3, one busy shared-board class period ≈ 3.5 GB ≈ $0.40. Cloud Run charges for egress too, so
  this isn't new, but it's the part of the bill that grows with use.
- There's also an Always Free `e2-micro` in `us-east1` (1 GB RAM, throttled CPU): fine to experiment on, too tight
  for both apps during live classes.

Sources: [economize.cloud e2-medium](https://www.economize.cloud/resources/gcp/pricing/compute-engine/e2-medium/),
[economize.cloud e2-standard-2](https://www.economize.cloud/resources/gcp/pricing/compute-engine/e2-standard-2/),
[gcloud-compute.com e2-medium](https://gcloud-compute.com/e2-medium.html),
[gcloud-compute.com e2-standard-2](https://gcloud-compute.com/e2-standard-2.html),
[Google: Network Service Tiers pricing](https://cloud.google.com/network-tiers/pricing),
[Google: VPC pricing announcement](https://cloud.google.com/vpc/pricing-announce).

## 7. Open questions

- After #48, are cold starts the only real complaint? (Read the `[load]` lines from a few real classes first.)
- Is the ops work in §5.6 worth it, or is "Google handles it" worth the Cloud Run trade-offs?
- Domain: which one, and do the room links students already have need to keep working?
- Portfolio angle: is a self-run VM setup (Caddy, systemd, SSH deploys) worth doing for its own sake?
- Would AllHail (or other future apps) live on the same box?

## 8. Deferred: if teaching in China later

Not relevant while in the US. Notes for later, unverified:

- Host in Hong Kong or Singapore (no ICP licence needed). The **route** matters more than the region: look for
  CN2 GIA / CMI routing, because cheap international links from the mainland can be congested and lossy in the evening.
- Anything the **browser** loads from Google (Drive import, Google fonts or scripts) is blocked in the mainland
  whatever the host. `*.run.app`, Cloudflare's free plan, and `github.io` short links can be slow or unreliable there.
- Measure first: from the school network, during class hours, `ping`/`mtr` a test server before choosing.

## 9. Decision log

- **21 Nov 2026:** options discussed, VM sketched, prices looked up. **No decision.** Production unchanged.
- **21 Nov 2026 (later):** ink send rate cut from 20/s to 2/s and cursors to 4/s (PR #50), capacity estimates added (§3.1). Still **no hosting decision.**
- **21 Nov 2026 (night):** production stress test before/after #50 (§3.1a): Cloud Run now handles ~10–15 classes at once. Still **no hosting decision**, but the pressure to move is much lower.
