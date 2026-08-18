# Where the truth lives

**Decided 2026-08-18.** One model, no duplicates.

## The rule

| Kind of document | Canonical home | Why |
|---|---|---|
| **Running state** — open items, drift logs, roadmap, test identities, session handoffs, delivery notes | **The Claude project** ("Quria Solutions - SMS Development Folder") | It is what every session reads first, and an agent can update it the moment something changes. A repo copy can only change through a PR that a human has to merge, so it is stale by design. |
| **Code-adjacent docs** — `CLAUDE.md`, `README.md`, `docs/0X_*.md` reference docs, `SECURITY_AUDIT_API.md`, migration notes | **This repo** | They describe code, they change with code, and they belong in the same diff as the code. |

**Nothing lives in both places.** If you find a second copy of a document, delete the copy that is not
in its canonical home above and put a pointer here instead.

## What moved on 2026-08-18

These were repo copies of documents whose maintained versions live in the Claude project. The repo
copies were 3+ weeks staler and were teaching every new session false facts. They were removed here:

| Removed from the repo | Read this instead (Claude project) |
|---|---|
| `SCHEMA_DRIFT_LOG.md` (repo copy last touched 2026-07-26) | `SCHEMA_DRIFT_LOG.md` |
| `TEST_IDENTITIES.md` (repo copy last touched 2026-07-26) | `TEST_IDENTITIES.md` |

**`DEV_ROADMAP.md` and `EMAIL_WORKFLOWS_TRACKER.md` STAY in this repo.** They are development
*history*, and history belongs with the code. Alexander's call, 2026-08-18.

What was actually wrong was not the files — it was the line in `CLAUDE.md` that force-loaded all
423 KB of `DEV_ROADMAP.md` into every session before any work began. That line is gone. Read the
roadmap when you need the history of a decision; don't treat it as current state.

**For current state, read `claude/OPEN_ITEMS_MASTER.md` in the Claude project.** It is the
one-page, dated, verified answer to "where are we". The roadmap is not.

Neither was deleted — both are in `docs/archive/` with their full git history, so nothing is lost.

Archived (stale one-off session notes, kept for history, **not** current state):
`SESSION_HANDOFF.md`, `NEXT_CHAT_BRIEF.md`, `BUILD_NOTES.md`, `WORKFLOW_TEST_PLAN.md`,
`session-2026-07-26-B1-tenant-email.md`, `PATH_TO_SELLABLE.md`.

## Also true

`DRIFT_REGISTER.md` and `PHASE_B_DRIFT_LOG.md` were never in this repo — they exist only in the
Claude project. Nothing to reconcile.
