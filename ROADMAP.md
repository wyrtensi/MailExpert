# MailExpert roadmap

Now / Next / Later, without dates. The detailed plan with acceptance criteria is
[docs/superpowers/plans/2026-09-11-mailexpert-shared-gmail-mvp.md](docs/superpowers/plans/2026-09-11-mailexpert-shared-gmail-mvp.md);
the target architecture is [docs/architecture/team-mail-system-handoff.md](docs/architecture/team-mail-system-handoff.md).

## Done

- Fork, full MailExpert rebrand and removal of upstream-only content.
- Full dependency modernization: Express 5, ImapFlow 2, Nodemailer 10, connect-redis 10 / Redis 6, React 19, React Router 7, Zustand 5, Tailwind 4, Electron 44.
- Google OAuth 2.0 for Gmail: PKCE S256, one-time Redis state, strict ID token checks, encrypted tokens, admin configuration and connect/reconnect UI.
- One OAuth token manager for every IMAP/SMTP path, with forced refresh on authentication failure and a persistent "reconnect required" state.
- Real IMAP authentication errors and bounded retry cooldowns instead of reconnect storms.
- Sign-in restricted to approved users, through Cloudflare Access or Google directly, with admin user management and Cloudflare Access policy sync.
- One shared install: the server connects mailboxes on its own schedule regardless of who is signed in, and every signed-in user works with every mailbox, its rules, block list and contacts.
- Mailbox audit log with an admin screen.
- Local demo mode for showing the product without a real mailbox.
- Gmail conversations threaded the way Gmail threads them: provider thread and message ids stored, no grouping by subject, a resumable backfill for already-cached mail, and a per-mailbox threading mode with preview, switch, rollback and a batched recompute.
- Several Google OAuth applications end to end. An unverified Google Cloud project accepts at most 100 unique users for its lifetime and the count never goes down, so mailboxes are spread over several projects: application selection with seat reservations, the grant journal, token refresh through the application a mailbox belongs to, revoke of refused and replaced grants, and the admin screen with active, closed and disabled states.
- One "Add account" entry: a Gmail address with suggestions of known addresses, and a manual IMAP/SMTP setup for administrators. Gmail mailboxes are reconnected from the sidebar and the Accounts tab.
- Google OAuth operations guide ([docs/operations/google-oauth.md](docs/operations/google-oauth.md)): separate development and production Google Cloud projects, consent screen mode, redirect URIs per host, app states, secret rotation, moving mailboxes between apps, revoke and removal.
- Sidebar mailbox filter and per-mailbox connection health.
- Selected upstream MailFlow fixes (see [upstream PR assessment](docs/architecture/upstream-pr-assessment.md)).
- Scripted production deployment for both sign-in hosts: `install.sh`/`configure.sh`, edge (Caddy or Cloudflare Tunnel), encrypted and verified restic backups, `update.sh`, a documented manual rollback and moving the panel to another server without losing data. Runbook: [docs/operations/deployment.md](docs/operations/deployment.md).

## Now

- Live OAuth lifecycle check on real accounts: consent, refresh after expiry, revoke, reconnect.
- Production acceptance: a full move rehearsal between two VPS following the deployment runbook, with downtime measured (docs/operations/deployment.md, section 8).

## Next

- Gmail scale test in waves of 10 → 25 → 50 → 100 mailboxes: memory, CPU, IMAP connections, provider errors and UI latency on the target server.
- 24-hour stability run, controlled restart and restore.
- Per-message threading diagnostics: the headers, the provider thread number, the reason a message landed in its conversation and the folders it lives in.

## Later

- Owned-domain mailboxes delivered through a separate Postfix/Dovecot mail node behind Microsoft EOP. The mail node is its own project with its own readiness criteria. MailExpert connects to it as an ordinary IMAP/SMTP server and creates, disables and re-enables mailboxes through the node's API. Platform choice, server sizing and adaptive quotas are researched in [docs/architecture/mail-node-research](docs/architecture/mail-node-research/README.md).
- A domain mailbox option in "Add account" with the mail node's connection settings, so a mailbox on it is created from that entry without typing hosts and ports. Its model and permissions get their own design together with the mail node.
- Individual manager identities and mailbox membership, if per-person accountability becomes a requirement on top of the audit log.

Have a request or found a bug? [Open an issue](https://github.com/wyrtensi/MailExpert/issues).
