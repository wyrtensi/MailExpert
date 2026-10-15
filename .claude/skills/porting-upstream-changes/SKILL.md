---
name: porting-upstream-changes
description: Use when checking MailFlow (upstream), Inboxora or another MailFlow fork for new commits, pull requests or issues worth taking into MailExpert, when asked "проверь новые коммиты в mailflow / inboxora", "есть ли что-то полезное в оригинальном репо", or when porting, adapting or rejecting an upstream change.
---

# Porting upstream changes

## Overview

MailExpert is a fork of MailFlow and also borrows ideas from other MailFlow
derivatives. A check is only cheap when it starts where the last one stopped:
the "Проверено до" section at the top of
`docs/architecture/upstream-pr-assessment.md` holds, per source, the last
reviewed commit and the date pull requests and issues were reviewed through.
Read it first; review only what is newer; move it forward in the same branch.

## Sources

| Source | Where | How to read it |
|---|---|---|
| MailFlow | remote `upstream` (`maathimself/mailflow`, `main` only, no tags) | commits `<marker>..upstream/main`, plus `gh pr list` / `gh issue list --repo maathimself/mailflow` updated after the marker date |
| Inboxora | remote `inboxora` (`Dragonk/Inboxora`, AGPL-3.0); add it with `git remote add inboxora https://github.com/Dragonk/Inboxora.git` if missing | separate history (rewritten in TypeScript, thousands of commits): read releases and release merges (`gh api repos/Dragonk/Inboxora/releases`), then the commits behind the topics that matter; take ideas, reimplement |
| Team-AER/hedwig | GitHub only (MailFlow fork, AGPL-3.0) | only when asked |

There is no merge-base with any source; never compare against MailExpert's
history. Fetch before reading (`git fetch upstream`, `git fetch inboxora`).

## Check

1. Read "Проверено до". A source without a marker: say so and ask the operator
   how far back to go, rather than reading the whole history.
2. List what is newer than the marker. Triage by title first: version bumps,
   sponsors, translations other than en/ru, docs and CI-only changes are
   "not needed" without reading the diff.
3. For each remaining item decide with the fit criteria below, reading the diff
   and grepping MailExpert for the affected code.
4. Write a dated section in the assessment document: one line per item with the
   decision — ported (MailExpert commit or PR), already ours (where), not needed
   (reason), deferred (what would change it).
5. Move the marker in the same branch, to the last item you actually reviewed.
   If you stopped partway, the marker stops there too.

## Fit

Take: defects that reproduce in MailExpert's model (shared mailboxes, many Gmail
and Microsoft accounts, the mailcow node behind EOP, IMAP/SMTP, the send queue,
threading by `thread_id`), and anything security-related (sanitizer, SSRF, TLS,
sessions, attachments).

Usually not: large standalone subsystems (ML antispam, MCP, template builder),
GTD extensions, UI reworks of panes MailExpert built differently, features
MailExpert already has in its own form (Google OAuth, threading, send queue).
Earlier decisions in the assessment document stand unless something changed;
cite them instead of reopening.

## Port

Follow `CONTRIBUTING.md` ("Porting changes from upstream MailFlow") and the
"Правило дальнейшего переноса upstream PR" section of the assessment document:
branch `sync/upstream-YYYY-MM-DD`, one change per commit, `git cherry-pick -x`
when it applies (the upstream author stays the author; you are the committer),
otherwise a reimplementation with an `Upstream: <repo>@<sha>` trailer, a failing
test first, the full backend and frontend checks before the PR. Code from
Inboxora or hedwig is never copied in bulk: reimplement and credit the source in
the trailer.

## Common mistakes

| Mistake | Instead |
|---|---|
| Rebuilding "what was checked last time" from commit messages | Read the marker; if it is wrong, fix it and say so |
| Reviewing "the last 20 commits" | Everything after the marker, or move the marker only as far as you got |
| Forgetting Inboxora because it is not a remote | Both sources every time the operator names both; add the remote |
| Leaving decisions only in the PR text | The assessment document is the log the next check reads |
