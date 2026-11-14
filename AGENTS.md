# AGENTS.md — orca-mailbox

Orca Lab plugin `ab2web.orca-mailbox`. Read README.md first; this file is the short
list of rules an agent must not break here.

## Hard rules

1. **Never permanently delete mail, on any provider.** All IMAP bytes go through
   `encodeCommand` (`src/providers/imap/commands.mjs`), which runs the guard in
   `src/domain/safety.mjs`. Do not add a second socket write, do not name
   `EXPUNGE`/`CLOSE`, `permanentDelete` or the full-access Gmail scope outside
   `safety.mjs`. `test/domain/safety.test.mjs` scans every shipped file for this.
2. **Credentials only in `secrets`.** The panel never receives a password or token;
   IMAP passwords are typed on the sidecar's loopback page. Requests to the sidecar
   go over stdin, never argv or env.
3. **One account at a time.** No combined list across accounts in the UI; actions
   apply only to the selected account.
4. **Public repo.** No secrets, tokens, real mail or personal addresses. Fixtures are
   hand-built with example.com / example.org and live under `e2e/`; no shipped file
   loads `e2e/` (`test/manifest.test.mjs`).
5. **Nothing heavy under the plugin root.** Orca hashes everything except `.git`
   (2,000 files, 50 MB) and rejects symlinks: no `node_modules` here. Harness
   dependencies live in `../.orca-mailbox-deps` (`npm run setup`).

## Where code runs

- `inbox.html`, `settings.html`: sandboxed iframes; only `storage.get/set` and
  `panel.runCommand`; everything inline; no network.
- `main.mjs`: plugin worker; no sockets, no file writes; commands must return within
  30 s, so long work runs in the background.
- `sidecar/mail-sidecar.mjs`: started by the worker with Orca's Node minus
  `NODE_OPTIONS`; may open sockets, listen on 127.0.0.1 and write the record store.

## Working here

- Strict TDD: watch the test fail, then make it pass. Pure logic lives in `src/domain`,
  `src/providers/*/mapping|commands|protocol`, `src/sync/record-store`, `src/worker`.
- `npm run check` (typecheck + tests) must pass before every commit; CI runs the same.
- Any panel change: `npm run shots && npm run sheets`, then look at every sheet.
- Conventional Commits, no AI attribution, feature branches, PRs only; the lead
  merges, tags and releases.
