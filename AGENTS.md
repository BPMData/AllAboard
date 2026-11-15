# AllAboard — notes for AI agents (Codex, Terra, Gemini, Claude)

**New here? Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first (the system map).** Before touching deployment,
storage, env vars, Cloud Run settings, or server startup code, read [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). The non-negotiables:

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
6. **Never use a *sensitive* or *restricted* Google OAuth scope. No exceptions, no "just for one feature",
   not incrementally.** Those trigger Google's manual sensitive-scope review (restricted ones also need a paid
   security audit), a 100-user cap and an "unverified app" screen until it passes, and school admins block them.
   **Allowed (non-sensitive):** `https://www.googleapis.com/auth/drive.file` (what Drive uses), plus the basic
   sign-in scopes `openid`, `email`, `profile` (`.../auth/userinfo.email`, `.../auth/userinfo.profile`).
   **Forbidden, for example:** `drive`, `drive.readonly`, `drive.metadata`, `drive.metadata.readonly`,
   `presentations`, `presentations.readonly`, `documents`, `spreadsheets`, `gmail.*`, `calendar*`, `classroom.*`.
   If a feature only works with a forbidden scope, **drop that part and write down why**. Before adding any
   scope not on the allowed list, check its category in Google's scope list and ask the owner.
   `tests/googleScopes.test.ts` enforces the allowed list.

Commands: `npm ci`, `npm run lint` (tsc), `npm test` (node:test via tsx), `npm run test:e2e` (Playwright).
