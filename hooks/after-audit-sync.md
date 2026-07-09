# Hook: after-audit-sync

Type: agent-read checkpoint instruction.
Consumed by: `agents/project-inspector.md`, immediately after each `audit-sync` run reports completion.

Not a Claude Code `hooks.json` event — a checklist the agent follows itself.

`audit-sync` is a documentation-maintenance tool (`workflowRole: maintenance`), run on demand in `maintenance` mode — not a step of the inspection workflow. It does not approve anything.

## Checklist

1. Confirm the skill treated `AUDIT.md` as **read-only**. If it reported changing any `AUDIT.md` cell — especially flipping a `Status` to `Approved` — flag it as a contract violation: the `Draft` -> `Approved` transition belongs exclusively to `audit-approve`, and `audit-sync` must never write `AUDIT.md`.
2. Confirm the skill modified `CLAUDE.md` only inside the two managed blocks (`audit-sync:caution-areas` and `audit-sync:important-files`). If it reported writing anywhere else in `CLAUDE.md`, or in `audits/`, `docs/`, or source, flag it and do not attempt to fix it yourself. As a location backstop, confirm the edited `CLAUDE.md` is at the real root — run `bun scripts/verify-artifacts.ts <TARGET_ROOT> CLAUDE.md`; on exit 2 STOP (the sync ran against a `.claude/worktrees/` path, not the repository).
3. Confirm the managed blocks were regenerated from ALL currently-`Approved` topics, not just recently changed ones — this is what keeps re-runs idempotent and repairs stale links. If the report suggests entries were appended rather than replaced, flag possible duplication.
4. Confirm the skill synced only topics that were already `Approved` in `AUDIT.md`. It must not have inferred approval or synced `Draft`/`Pending Breakdown` topics.
5. If the skill reported a consistency/drift issue (a broken `File` reference, a status/slug mismatch, a missing audit file for an `Approved` row), surface it to the developer as an action item — `audit-sync` reports these but does not fix `AUDIT.md`. Do not silently correct anything yourself.
6. This is maintenance, not workflow advancement — do not treat a completed sync as advancing any inspection stage, and do not auto-run it again. In your report, tell the developer how many Approved topics were synced and list any consistency issues found.

## Why this exists

`audit-sync` is the only tool that writes back into `CLAUDE.md`, through fragile marker-delimited blocks. This hook is the enforcement point that keeps those edits inside the managed markers, keeps `AUDIT.md` read-only for this skill (approval stays with `audit-approve`), verifies the idempotent full-regeneration contract independently of the LLM-driven edit, and routes any detected drift to the developer as an action item rather than a silent fix.
