# Changelog

## 0.6.0 — 2026-07-04

Made the inspection workflow fully registry-driven. `scripts/inspection-state.ts` previously hardcoded the stage list, order, produced artifacts, and completion/resume logic; it now derives all of that from `skills/registry.json`.

- Added a `completion` field to `workflow`+`inspection` registry entries: `"artifacts"` (complete when all `produces` exist — the default) or `"topics"` (complete when every AUDIT.md topic is Approved). Set `artifacts` for `project-analysis`/`project-docs`, `topics` for `audit-breakdown`/`audit-approve`.
- Refactored `scripts/inspection-state.ts` to load `registry.json` and compute per-stage completion, `completedStages`, `currentStage`, `stage3Complete`, and the `resume` pointer generically from each stage's `stage`, `produces`, and `completion`. Removed the hardcoded `NON_TOPIC_STAGES` and stage-specific artifact/resume logic. Still fully deterministic — no logic moved to the LLM.
- Result: adding a new **linear** workflow skill now requires only creating `skills/<id>/SKILL.md` and adding one registry entry (with `produces` + `completion`). The agent executes it (its loop was already generic) and the state helper tracks/resumes it automatically — no edits to the script, agent, or plugin.json. Verified by temporarily adding a stage-5 entry and observing it auto-tracked and resumed.
- Registry `description` documents the `produces`/`completion` completion contract. Small update to `skills/inspection-state/SKILL.md` and the architecture docs to reflect the registry-driven behavior.
- The agent and the workflow shape are unchanged; no new commands.
- No changes to any target repository's source code.

## 0.5.0 — 2026-07-03

Added `inspection-state`, an internal infrastructure skill that tracks resumable inspection state per repository.

- New internal skill `skills/inspection-state` (registry `type: internal`, `autoInvoke: true`) — not user-facing, no command. The agent invokes it automatically at startup and after each stage/loop step. It owns a single file, `<repo>/.ono/state.json`.
- New deterministic helper `scripts/inspection-state.ts` (`detect` / `init` / `sync` / `set-stage` / `migrate`). `AUDIT.md` stays the source of truth; state.json mirrors it into portable orchestration state.
- State file tracks: plugin version + `stateSchemaVersion`, completed stages, a reconciled snapshot of the AUDIT.md topics (status/counts/timestamps), and a `resume` pointer. Detects prior inspection, detects plugin/schema version mismatch, and supports schema migrations.
- Portable by design: stores only repo-relative paths and the git remote — never absolute filesystem paths — so it is committed to Git and travels across machines/clones. `.ono/` is the shared Ono infrastructure directory; this plugin owns only `state.json`.
- Introduced a `type` field on registry entries (`workflow` vs `internal`) to cleanly separate user-facing workflow skills from auto-invoked infrastructure. Existing entries tagged `type: workflow`.
- Wired the agent (`before-inspect` startup detect/init/migrate/version/resume; `sync` after each step; `status` mode reads state via `detect`) to use the resume pointer instead of re-deriving progress from files.
- Updated `.claude-plugin/plugin.json` (registered the skill, bumped to 0.5.0), `README.md`, `docs/plugin-workflow.md`, `docs/architecture.md`.
- No changes to any target repository's source code.

## 0.4.0 — 2026-07-03

Redesigned the audit approval workflow around a dedicated `audit-approve` skill, so each skill has a single responsibility. Previously, "approve & continue" only advanced to the next Draft and never finalized the reviewed topic — Drafts accumulated with none marked `Approved`. Approval is now its own step.

- Added `audit-approve` (stage 3, approval half of the new breakdown → approve loop). It is the single owner of the `Draft` → `Approved` transition: it validates the topic is `Draft`, flips its `AUDIT.md` row to `Approved`, confirms the permanent file reference, and never generates a topic or touches `CLAUDE.md`.
- Reworked `agents/project-inspector.md`: Stage 3 is now a breakdown → review → approve → continue loop. After a clean `audit-approve`, the agent immediately breaks down the next `Pending Breakdown` topic and stops at its review gate; when all topics are `Approved` it reports Stage 3 complete. Added a fifth invocation mode (`maintenance`) and redefined `resume` to finalize the reviewed Draft.
- `/inspect-approve` now finalizes the reviewed Draft (runs `audit-approve`) and continues the loop, instead of merely advancing one breakdown cycle.
- Added `/inspect-sync` and a `maintenance` mode to run `audit-sync` on demand.
- Repurposed `audit-sync` as a documentation-maintenance tool only (`workflowRole: maintenance`), removed from the linear workflow. It no longer marks anything `Approved` and now treats `AUDIT.md` as read-only — it syncs approved findings into the `CLAUDE.md` managed blocks, verifies consistency, detects drift, and repairs references inside its blocks.
- Extended `skills/registry.json` with `role`, `pairsWith`, and `workflowRole` fields to express the breakdown/approve pairing and the maintenance role. `audit-breakdown` unchanged in responsibility (create one Draft, stop) — only its completion/approval wording now points at `audit-approve`.
- Added hook `after-audit-approve`; updated `after-audit-sync` (maintenance, no approval) and `after-audit-breakdown` (points at approve). Extended `scripts/update-audit-index.ts` to verify the file reference on `Approved` rows too.
- Updated `.claude-plugin/plugin.json` (registered the new skill and command, bumped to 0.4.0), `README.md`, `docs/plugin-workflow.md`, and `docs/architecture.md`.
- No changes to any target repository's source code.

## 0.3.0 — 2026-07-02

Completed the four-stage workflow and prepared for distribution.

- Vendored and enabled `audit-sync` (stage 4) — marks developer-approved topics `Approved` in `AUDIT.md` and regenerates the two managed blocks in `CLAUDE.md` from all Approved topics. Previously registered as a disabled placeholder.
- Vendored and enabled `project-docs` (stage 2) — builds a descriptive `docs/project/` knowledge base (overview, component inventory, patterns, integrations). Adapted to this plugin's conventions: read-only shell rules instead of the external guard-marker/PreToolUse mechanism, direct read-only inspection instead of a `repo-scanner` agent, and all four templates embedded in `SKILL.md` instead of external template files.
- Fixed a cross-skill coupling gap: `project-analysis`'s `CLAUDE.md` template now emits the `audit-sync:important-files` and `audit-sync:caution-areas` managed-block markers that `audit-sync` depends on, with placeholder content and a rule to preserve them.
- Renumbered the workflow to four stages: `project-analysis` → `project-docs` → `audit-breakdown` → `audit-sync`, all enabled in `skills/registry.json`.
- Added hook checkpoints `after-project-docs` and `after-audit-sync`.
- Updated `.claude-plugin/plugin.json` skills list and bumped the version.
- Added `.claude-plugin/marketplace.json` so the plugin is installable via the Ono internal AI Marketplace, plus a `.gitignore` for repository hygiene.
- Updated `README.md` and `docs/plugin-workflow.md` to document all four enabled stages.
- No changes to any target repository's source code.

## 0.2.0 — 2026-07-02

Expanded command API.

- Added `/inspect-status` — read-only progress report, invokes no skill.
- Added `/inspect-topic` — targeted single-topic breakdown, bypassing the general narrative.
- Added `/inspect-approve` — explicit, discoverable approval to advance one gate.
- Added an "Invocation Modes" section to `agents/project-inspector.md` (`full`, `status`, `targeted`, `resume`) so the same orchestrator dispatches correctly per command, with no duplicated orchestration logic.
- Updated `.claude-plugin/plugin.json` commands list.
- Updated `README.md` and `docs/plugin-workflow.md` to document all four commands.
- No changes to skill business logic (`project-analysis`, `audit-breakdown`) and no changes to any target repository's source code.

## 0.1.0 — 2026-07-02

Initial release.

- Added orchestrating agent `agents/project-inspector.md`.
- Added `/inspect` command.
- Vendored existing skills: `project-analysis`, `audit-breakdown`.
- Added `skills/registry.json` as the extensibility seam for future skills.
- Registered `audit-sync` as a disabled placeholder — skill not yet implemented locally.
- Added agent-read hook checkpoints: `before-inspect`, `after-project-analysis`, `after-audit-breakdown`.
- Added deterministic verification scripts: `slugify.ts`, `update-audit-index.ts`.
- Added architecture and workflow documentation.
