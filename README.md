# Mailbox for Orca Lab

An Orca Lab plugin that loads the headers of all your mail (sender, recipients,
subject, date, flags, size, folder) so you can see what is in each mailbox, and in
later versions group it, filter it and clean it up in bulk, safely.

**Version 0.1 (slice 1) is read-only.** It never moves, flags or deletes mail.

| Works now | Comes next |
|---|---|
| Any IMAP mailbox over TLS (port 993): cPanel hosting, Zoho, iCloud, Yahoo, Gmail with an app password | Gmail and Outlook / Microsoft 365 sign-in (slice 1b) |
| Several accounts, shown one at a time with an account switcher | Grouping and filters by sender, category, age, size (slice 2) |
| Resumable, newest-first header sync with progress, totals and the latest messages | Trash, archive, label/move, mark read, with guards (slice 3) |

Mail is never mixed across accounts: the panel shows one account at a time, with its
own counts, size and sync state.

## Install (development)

Orca → Settings → Plugins → Install plugin → **Local folder**, and pick this folder.
Requires Orca `>= 1.4.160`. The plugin asks for three capabilities: `storage`,
`secrets` and `process:spawn` (it starts the helper process described below).

## Add an IMAP account

Settings → Mailbox → *Add an IMAP account*:

- **cPanel hosting**: server `mail.yourdomain.com` (or the server name your host
  gives), port `993`, username = the full email address.
- **Gmail** (until Google sign-in ships): server `imap.gmail.com`, port `993`, and an
  [app password](https://support.google.com/accounts/answer/185833) (needs 2-Step
  Verification). Gmail shows labels as IMAP folders, so a message with two labels is
  counted in both; the Gmail API provider in slice 1b counts each message once.
- **Outlook / Microsoft 365** cannot be added over IMAP with a password: Microsoft
  turned basic authentication off ([Exchange Online](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online)).
  Checked live: `outlook.office365.com` advertises `LOGINDISABLED` and only
  `AUTH=XOAUTH2`. It waits for Microsoft sign-in (slice 1b).

**Continue in browser** opens a page served by your own computer
(`http://127.0.0.1:<port>/<random>`). Type the password there: the plugin tests it
against the server and keeps it in Orca's secrets. The panel never sees it.

## Where each part runs

Orca runs a plugin's worker in a sandbox. Checked in the source
(`orca-oss src/main/plugins/plugin-host-preload.ts:3-29`,
`plugin-worker-sandbox-args.ts:11-22`) and live under Orca's own binary
(`e2e-results/live/host-sandbox-probe.md`):

- the worker cannot import `net`, `tls`, `http` or `dns`, even with `net:fetch`;
  `net:fetch` only allows the global `fetch` to declared hosts;
- the worker cannot write files;
- host storage holds at most 5 MiB per plugin and 256 KiB per value
  (`src/shared/plugins/plugin-host-api.ts:68-70`), which is too little for 14,000+
  messages; `secrets` are reachable from the worker only.

So the plugin has three parts:

| Part | File | Does |
|---|---|---|
| Panels | `inbox.html`, `settings.html` | Read and write host storage only. |
| Worker | `main.mjs` | Bridges panels, secrets and the helper; keeps passwords in `secrets`. |
| Helper (sidecar) | `sidecar/mail-sidecar.mjs` | Holds the IMAP connection, the loopback page and the header store. Started with Orca's own Node and without the worker's permission flags (`/usr/bin/env -u NODE_OPTIONS`, the pattern orca-wa-inbox ships). |

The worker declares no `net:fetch` hosts because it makes no network calls; the helper
connects only to the mail servers you add (and, from slice 1b, to Google's and
Microsoft's sign-in and mail APIs).

## Data and privacy

- **Headers only.** No bodies, no attachments.
- Headers are stored on this computer, per account, in
  `<Orca user data>/plugins-data/ab2web.orca-mailbox/mail/<account>/` (or
  `~/.orca-mailbox/` when Orca does not pass its user data path): `records.jsonl` (an
  append-only log, compacted after each full sync) and `state.json` (sync cursors).
- Host storage keeps the account list (no passwords), sync status and a small
  snapshot per account (totals and the 50 newest messages).
- Passwords are kept in Orca's `secrets` (the OS keychain through Electron
  `safeStorage`). **Remove** deletes the password, the snapshot and the local copy;
  your mailbox is not touched.

## Safety: nothing is ever deleted for good

| Provider | Trash means | Locked by |
|---|---|---|
| IMAP | `MOVE` to the server's Trash (found with SPECIAL-USE `\Trash`, or the name you configure) | `src/domain/safety.mjs` refuses `EXPUNGE`, `UID EXPUNGE` and `CLOSE` unless Trash is selected; every IMAP byte goes through that guard |
| Gmail | `messages.trash` | **Scope**: `gmail.modify` cannot permanently delete (below) |
| Microsoft Graph | move to Deleted Items | Code: the guard refuses `DELETE` and `permanentDelete` |

`test/domain/safety.test.mjs` fails if the requested Gmail scopes include
`https://mail.google.com/`, if any shipped file names that scope, `permanentDelete`, or
an `EXPUNGE`/`CLOSE` command outside the guard. In slice 1 folders are opened with
`EXAMINE`, which the server keeps read-only.

## Gmail: scope, sign-in and Google Cloud setup

### Scope: `https://www.googleapis.com/auth/gmail.modify`

From [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
(classified **Restricted**):

> `gmail.modify`: "Read, compose, and send emails from your Gmail account." "This scope
> does not allow immediate, permanent deletion of threads and messages, bypassing the
> trash."

> `https://mail.google.com/`: "Read, compose, send, and permanently delete all your
> email from Gmail."

[`users.messages.delete`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/delete)
"Requires the following OAuth scope: `https://mail.google.com/`" (the same holds for
`threads.delete` and `messages.batchDelete`). `gmail.modify` covers listing, reading
metadata, `messages.trash`, `messages.modify`/`batchModify` (archive = remove the
`INBOX` label, label, mark read). `gmail.metadata` is narrower but cannot use the `q`
search parameter, which later slices need. **Permanent delete is impossible by scope.**

### Sign-in proof in the Orca host

Google's installed-app flow is an authorization code with PKCE and a loopback redirect
([native apps](https://developers.google.com/identity/protocols/oauth2/native-app)).
The worker cannot listen on loopback; the helper can (live, above). Run under Orca's
own Node, `scripts/oauth-probe-google.mjs --dry-run` starts the plugin's real loopback
server, receives a redirect, and sends the plugin's authorization request to Google,
which answers `invalid_client` — the only missing piece is your OAuth client
(`e2e-results/live/oauth-google-dry-run.json`). **The full sign-in is pending** until
the client below exists; then run:

```sh
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
  /usr/bin/env -u NODE_OPTIONS ELECTRON_RUN_AS_NODE=1 \
  /Applications/Orca.app/Contents/MacOS/Orca scripts/oauth-probe-google.mjs
```

It opens the consent page, exchanges the code, reads your Gmail profile counts and
prints the granted scopes and token lifetimes. Tokens are thrown away.

### Google Cloud setup (owner)

1. [Google Cloud console](https://console.cloud.google.com/) → create a project.
2. APIs & Services → Library → enable **Gmail API**.
3. OAuth consent screen (Google Auth Platform): user type **External** (personal
   Gmail) or **Internal** (a Workspace domain, only its users); publishing status
   **Testing**.
4. Data access → add the scope `https://www.googleapis.com/auth/gmail.modify`.
5. Audience → **Test users**: add each Gmail address that will sign in (up to 100).
6. Clients → Create client → application type **Desktop app**. No redirect URI is
   entered: Desktop clients accept `http://127.0.0.1:<any port>`.
7. Keep the client ID and secret; slice 1b asks for them in Settings → Mailbox and
   keeps the secret in Orca's secrets.

### Token lifetime

- **Refresh token, Testing status, External user type: 7 days.** "A Google Cloud
  Platform project with an OAuth consent screen configured for an external user type
  […] is issued a refresh token expiring in 7 days" (the elided part names the
  "Testing" publishing status)
  ([OAuth 2.0, refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)).
  Expect to sign in again weekly while the app stays in Testing.
- Internal (Workspace) user type: the page names only the External case. **Unverified**
  whether Internal apps get longer-lived tokens; the probe will show it.
- Access token: the page says only "Access tokens have limited lifetimes." The usual
  value is one hour; **unverified** here, the probe prints `expires_in`.
- Refresh tokens also end when the password changes (Gmail scopes), after six months
  unused, or when an admin restricts the service.

### Can a Google Workspace domain block this?

Yes. A Workspace admin can restrict Gmail as a service in **API controls** so only
trusted apps reach it, block an app, or block third-party apps entirely
([control which apps access Workspace data](https://knowledge.workspace.google.com/admin/apps/control-which-apps-access-google-workspace-data)).
For a Workspace account the admin may need to mark this OAuth client as trusted; if
not, IMAP with an app password is the fallback, where the domain allows it.

## Outlook and Microsoft 365: permission and Entra setup

**Permission: `Mail.ReadWrite` (delegated), plus `User.Read` and `offline_access`.**
`Mail.ReadWrite` is the least privileged permission for
[move](https://learn.microsoft.com/en-us/graph/api/message-move) and for
[update](https://learn.microsoft.com/en-us/graph/api/message-update) (`isRead`);
`Mail.Read` covers neither. Graph has no split like Gmail's: the
[permanentDelete](https://learn.microsoft.com/en-us/graph/api/message-permanentdelete)
table lists "Delegated (work or school account) | Mail.ReadWrite" and "Delegated
(personal Microsoft account) | Mail.ReadWrite". **Permanent delete cannot be excluded by
permission on Graph**; the plugin's guard refuses it in code and tests check that.

Entra app registration (owner), for slice 1b:

1. [Entra admin center](https://entra.microsoft.com/) → App registrations → New.
2. Supported account types: **Accounts in any organizational directory and personal
   Microsoft accounts** (covers Microsoft 365 and outlook.com).
3. Authentication → Add a platform → **Mobile and desktop applications**; redirect
   URI `http://127.0.0.1`. Microsoft recommends "the IP literal loopback address
   `127.0.0.1` in your redirect URI instead of `localhost`", ignores the port for
   loopback, and does not let the portal's Redirect URIs text box add an `http`
   loopback URI, so add it in the app **Manifest** if the box refuses
   ([redirect URI rules](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url)).
4. Authentication → Advanced → **Allow public client flows: Yes**. No client secret.
5. API permissions → Microsoft Graph → Delegated → `Mail.ReadWrite`, `User.Read`,
   `offline_access`.
6. Refresh tokens last 90 days for this kind of app
   ([refresh tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens)).

## Development

The harness (TypeScript for the JSDoc type check, Playwright for screenshots) lives in
`../.orca-mailbox-deps`, outside the plugin: Orca hashes every file under the plugin
root, rejects symlinks and caps the tree at 2,000 files and 50 MB.

```sh
npm run setup                 # once; add -- --browsers if Playwright has no Chromium
npm run check                 # typecheck + unit tests (also what CI runs)
npm run shots                 # 72 screenshots: 2 panels, 9 states, 4 widths, 2 themes
npm run sheets                # contact sheets of the screenshots, to look at them all
```

Screenshots use hand-built sample data (`e2e/fixtures/sample-mailbox.mjs`,
example.com / example.org); no shipped file loads it. Screenshots and sheets are build
output in `e2e-results/` and are not committed.

## Known limits of 0.1

- Windows is untested: the helper is started with `/usr/bin/env`.
- Gmail over IMAP counts a message once per label (see above); `\All` (All Mail) is
  skipped so totals are not doubled again.
- No live IMAP sync has run against a real mailbox yet; the parser, page plan and store
  are unit-tested, and the client was checked live against two public servers without
  signing in. The first real run is the owner's cPanel mailbox.
