# Host sandbox probe (2026-11-14)

Reproduces how Orca launches a plugin worker: Orca's own Electron binary as Node
(`ELECTRON_RUN_AS_NODE=1`, Electron 43.8.6, Node 24.22.1) with the flags of
`orca-oss src/main/plugins/plugin-worker-sandbox-args.ts` (`--permission`,
`--allow-fs-read` on the plugin root and host dir, `--require plugin-host-preload.js`
from `/Applications/Orca.app/.../app.asar.unpacked/out/main/`, `--allow-child-process`).
It is a faithful reproduction, not a run inside the Orca app: Orca has no CLI to install
a plugin or invoke its commands.

| Check | Worker | Child, plain spawn | Child via `/usr/bin/env -u NODE_OPTIONS` |
|---|---|---|---|
| `import('node:tls')` / `node:http` | denied: "Plugin network access denied: tls requires net:fetch" | allowed | allowed |
| TLS to imap.gmail.com:993, read greeting | n/a | OK (`* OK Gimap ready…`, cert authorized) | OK (same) |
| `listen(0, '127.0.0.1')` + request to itself | n/a | OK | OK |
| Write a file outside the plugin root | denied (`ERR_ACCESS_DENIED`) | denied (`ERR_ACCESS_DENIED`) | OK |
| Spawn `/usr/bin/open` | n/a | OK | OK |

Conclusion: the worker can hold neither the IMAP socket nor the OAuth loopback
listener nor a record store. A sidecar started with Orca's Node and without
`NODE_OPTIONS` can do all three; that is how `main.mjs` starts `sidecar/mail-sidecar.mjs`.

The client IP in Gmail's greeting is left out of this file on purpose.

Related live runs in this folder:
- `imap-client-capability.jsonl`: the plugin's IMAP client against imap.gmail.com and
  outlook.office365.com (no credentials): greeting, CAPABILITY parsed, EXPUNGE refused
  by the guard before any byte was written.
- `oauth-google-dry-run.json`: `scripts/oauth-probe-google.mjs --dry-run` under Orca's
  Node: the real loopback server receives the redirect, and Google's authorization
  endpoint answers the plugin's request with `invalid_client` (the only thing missing
  is the owner's OAuth client).
