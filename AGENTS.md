# AllAboard — notes for AI agents (Codex, Terra, Gemini, Claude)

**Before touching deployment, storage, env vars, Cloud Run settings, or server startup code, read
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).** The non-negotiables:

1. **AI Studio Publish rewrites the Cloud Run service config.** Console-added volume mounts vanish and env vars
   come and go. Anything that must persist is configured **in code**. Code must tolerate stale env vars.
2. **Production runs `node server.ts` (type stripping), and tests run `tsx`.** No parameter properties, `enum`,
   `namespace`, or `import x = require()` in server-side code. Always run:
   `node -e "import('./server.ts').then(() => console.log('OK'))"`
3. **Two containers:** nginx on 8080 forwards to `app-container` on 3000. Keep `PORT=3000` on app-container.
   Never move the probe to 8080.
4. **Cloud Run disk is wiped** on cold start and redeploy. Durable copy: `gs://allaboard-data`, written over the
   Cloud Storage JSON API (`backupMirror.ts`, `GcsBackend`). Never put SQLite on a bucket mount. Never "fix" a
   storage error with `/tmp`.
5. **Max instances = 1.** Storage setup must **fail open**, never crash boot.

Commands: `npm ci`, `npm run lint` (tsc), `npm test` (node:test via tsx), `npm run test:e2e` (Playwright).
