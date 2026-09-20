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
- Storage for several Google OAuth applications: the tables, the import of the configured application and token refresh through the application a mailbox belongs to. The flows on top of it are still to come — see Now.
- Sidebar mailbox filter and per-mailbox connection health.
- Selected upstream MailFlow fixes (see [upstream PR assessment](docs/architecture/upstream-pr-assessment.md)).

## Now

- Several Google OAuth applications end to end. An unverified Google Cloud project accepts at most 100 unique users for its lifetime and the count never goes down, so mailboxes are spread over several projects: application selection and reservation, the admin screen, revoke, and the connection flows built on them.
- One "Add account" entry with three ways in: a Gmail address, a mailbox on the configured owned-domain server, and a manual IMAP/SMTP setup for administrators.
- Connection settings for the owned-domain mail server, so a mailbox on it can be created from that same entry without typing hosts and ports.
- Deployment and runbooks for both sign-in hosts, and Google OAuth operations: separate development and production Google Cloud projects, consent screen mode, redirect URIs, secret rotation, revoke and data removal.
- Live OAuth lifecycle check on real accounts: consent, refresh after expiry, revoke, reconnect.
- Clean deployment from the documentation with backup and restore of PostgreSQL together with the encryption key.

## Next

- Gmail scale test in waves of 10 → 25 → 50 → 100 mailboxes: memory, CPU, IMAP connections, provider errors and UI latency on the target server.
- 24-hour stability run, controlled restart and restore.
- Google OAuth app verification for production use with personal Gmail accounts.
- Per-message threading diagnostics: the headers, the provider thread number, the reason a message landed in its conversation and the folders it lives in.

## Later

- Owned-domain mailboxes delivered through a separate Postfix/Dovecot mail node behind Microsoft EOP. The mail node is its own project with its own readiness criteria; MailExpert only connects to it as an ordinary IMAP/SMTP server.
- Individual manager identities and mailbox membership, if per-person accountability becomes a requirement on top of the audit log.

Have a request or found a bug? [Open an issue](https://github.com/wyrtensi/MailExpert/issues).
