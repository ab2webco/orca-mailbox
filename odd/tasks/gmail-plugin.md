# Mailbox plugin (orca-mailbox) — task file

Ticket: GMAIL-SYNC. Branch: `gmail-sync`. Public remote `ab2webco/orca-mailbox`: one PR
with CI green; no merge, tag or release (the lead does that after the owner approves).
The repo is public: no secrets, tokens, real mail or personal addresses; fixtures are
hand-built.

## Objective

An Orca Lab plugin that loads all of the owner's mail across several accounts and
providers (Gmail, Outlook / Microsoft 365, any IMAP host such as cPanel), groups and
filters it, and lets the owner act on it in bulk safely. Nothing is ever permanently
deleted.

## Slices

1. **Slice 1 (this task)** — skeleton, provider interface, IMAP provider end to end
   (connect + metadata sync), Gmail OAuth host proof and scope research, Outlook scope
   research, multi-account model, resumable rate-limited metadata sync, read-only panel.
2. Grouping and filters without an LLM: counts and bytes per sender, category, age.
3. Actions with guards: trash, archive, label/move, mark read (per-provider semantics).
4. Opt-in Jev classification through TypeSafe.

## Slice 1 checklist

- [ ] S1-01 Skeleton: `orca-plugin.json` (id `orca-mailbox`, publisher `ab2web`),
      nav panel, settings panel, README, AGENTS.md, check script; manifest test.
- [ ] S1-02 Host facts: can the worker open raw TCP/TLS sockets and listen on loopback?
      Evidence from orca-oss source. Decide where IMAP and the OAuth loopback run.
- [ ] S1-03 Domain model: normalized message record (accountId, provider, folder, from,
      to, subject, date, flags/labels, size, snippet), account model, record mapping
      per provider, size and count totals. Unit tests on hand-built records.
- [ ] S1-04 Safety guards: tests that fail if any code path can issue IMAP EXPUNGE
      outside Trash, call Graph `permanentDelete`, or request `https://mail.google.com/`.
- [ ] S1-05 Sync engine: paginated, resumable cursor, rate limit with exponential
      backoff, progress reporting; provider-agnostic. Unit tests.
- [ ] S1-06 IMAP provider: TLS connect (993), LOGIN, LIST + SPECIAL-USE (Trash
      discovery with configurable fallback), UID FETCH metadata in batches. Protocol
      parser unit tests on hand-built server responses.
- [ ] S1-07 Gmail: OAuth loopback + PKCE proof in the host, narrowest scope chosen and
      cited, token lifetime documented, metadata mapping. Sync implemented or moved to
      slice 1b, stated with the reason.
- [ ] S1-08 Outlook: narrowest Graph delegated permission researched and cited, Entra
      app registration steps documented. Sync implemented or moved to slice 1b.
- [ ] S1-09 Worker wiring: commands, secrets for credentials, storage for records and
      progress, panel ↔ worker request channel through storage.
- [ ] S1-10 Panels: nav panel shows ONE account at a time with an account switcher
      (its sync progress, total count, total size, recent messages list; never a mixed
      list); settings panel (add IMAP account, remove account). Nothing destructive.
- [ ] S1-11 Screenshots of both panels at 1440, 768, 390, 320, light and dark, read and
      kept under `e2e-results/`.
- [ ] S1-12 Live probes: what ran live, what is pending for the owner (cPanel IMAP,
      Google Cloud client, Entra app).
- [ ] S1-13 CI: GitHub Actions running typecheck and tests; branch pushed; ONE PR on
      ab2webco/orca-mailbox with CI green.

## Acceptance criteria

- Every stored record carries `accountId` and `provider`; the UI only reads the
  normalized record, one account at a time.
- Credentials (passwords, tokens) are only written through the `secrets` capability.
- The requested Gmail scope set excludes `https://mail.google.com/`; a test fails if
  it does not.
- No code path can issue IMAP `EXPUNGE` outside the Trash folder or Graph
  `permanentDelete`; a test fails if one can.
- Sync is resumable: stopping and restarting continues from the saved cursor.
- Both panels render without overflow at the four widths in both themes.

## Checks

- `npm run check` — manifest validation, unit tests, panel script parse, safety guards.
- `npm run shots` — panel screenshots into `e2e-results/`.
- Live: IMAP against a real mailbox (owner), Gmail OAuth (owner, needs the Google
  Cloud client), Graph OAuth (owner, needs the Entra app).
