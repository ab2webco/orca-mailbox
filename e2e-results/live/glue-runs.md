# Glue runs without credentials (2026-11-14)

All under Orca's own binary (Electron 43.8.6, Node 24.22.1). No mailbox, no
credentials, no test doubles.

1. **Worker module loads inside the sandbox.** `main.mjs` imported with the worker's
   flags and Orca's `plugin-host-preload.js` (`--permission`, `--allow-fs-read` on
   the plugin root only): `{"defaultExport":"function","deactivate":"function"}`.
   Nothing it loads is a denied module.
2. **Sync against a closed port.** `sidecar/mail-sidecar.mjs` with
   `{"op":"sync", host 127.0.0.1, port 1}` on stdin, `ORCA_USER_DATA_PATH` pointed
   at a scratch folder:
   `{"type":"error","accountId":"imap-probe0001","kind":"network","message":"127.0.0.1: connect ECONNREFUSED 127.0.0.1:1"}` — exit 1 after about 7 s (five connection attempts with
   exponential backoff), the error line arrives before the exit (stdout flushed),
   and nothing is written to disk.
3. **Remove.** `{"op":"remove","accountId":"imap-probe0001"}` on a scratch account
   folder: `{"type":"removed",...}`, exit 0, folder gone.
4. **Closed socket.** `imap-client-closed-socket.json`: after `logout()`, a new
   command is rejected in 1 ms and a second `logout()` returns (before the fix the
   second `logout()` hung).

Not run: a sync against a real mailbox (needs the owner's cPanel account) and the
credential page through the worker inside the Orca app (Orca has no CLI to install a
plugin or invoke its commands).
