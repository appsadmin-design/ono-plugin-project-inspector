# Hook: after-project-analysis

Type: agent-read checkpoint instruction.
Consumed by: `agents/project-inspector.md`, immediately after the `project-analysis` skill reports completion.

Not a Claude Code `hooks.json` event — a checklist the agent follows itself.

## Checklist

1. **Independently verify artifacts at the real root — do not rely on the skill's textual "written" report.** Run `bun scripts/verify-artifacts.ts <TARGET_ROOT> CLAUDE.md AUDIT.md`. Advance only on exit 0. On failure:
   - exit 2 (`target-root-is-worktree`) → root resolution failed upstream; STOP and report — the workflow must not run against a `.claude/worktrees/` path.
   - exit 4 → an artifact is missing at the real root. If the JSON shows `leakedTo` pointing under `.claude/worktrees/…`, report that the skill wrote into a Claude agent worktree instead of the repository. In all exit-4 cases: do NOT advance to `audit-breakdown` and do NOT report the stage complete; report the gap to the developer instead.
2. Confirm the report explicitly states `audits/` was **not** created. If the skill's own output contract was violated (e.g. it created `audits/` prematurely), flag this to the developer — do not silently continue, and do not attempt to fix it yourself (you never touch repository files directly).
3. Read the `AUDIT.md` topic count from the skill's summary. Include it in your own stage-transition report to the developer.
4. This stage always has `requiresApproval: true` in the registry — stop here regardless of how clean the output looks. Do not auto-invoke `audit-breakdown`.
5. When presenting the pause to the developer, surface the recommended first breakdown topic that `project-analysis` reported, so approving forward progress is a one-line reply.

## Why this exists

`project-analysis` and `audit-breakdown` are independent skills that don't know about each other's execution at runtime — this hook is where the orchestrator enforces the contract between them (audit index must exist and be well-formed before breakdown starts) without either skill needing to be aware of the other.
