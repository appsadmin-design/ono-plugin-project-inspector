---
name: audit-approve
description: >-
  Finalizes exactly one Draft audit topic. Validates that the named topic
  (default: the one audit-breakdown just drafted) is in Draft state, marks its
  AUDIT.md row Approved, confirms the permanent audit-file reference, and
  records optional approval metadata. It never generates a topic, never
  inspects source code, and never edits CLAUDE.md or audit files. It is the
  single owner of the Draft -> Approved transition. After it completes, the
  Project Inspector agent continues to the next Pending Breakdown topic.
---

# Audit Approve Skill

## Purpose

Finalize one developer-reviewed Draft audit topic by transitioning its status in `AUDIT.md` from `Draft` to `Approved`.

This skill is the **approval half of the Stage 3 breakdown-approve loop**:

1. `audit-breakdown` creates one Draft audit document and stops for review.
2. The developer reviews the Draft.
3. `audit-approve` (this skill) marks that topic `Approved`.
4. The Project Inspector agent then invokes `audit-breakdown` for the next Pending Breakdown topic.

This skill has exactly one responsibility: **turn a reviewed Draft into an Approved topic.** It is not a breakdown skill, a documentation sync skill, a code reviewer, or a task generator.

## Single-Responsibility Boundaries

This skill:

- **Does** validate that the selected topic is currently `Draft`.
- **Does** flip only that topic's `Status` from `Draft` to `Approved` in `AUDIT.md`.
- **Does** confirm the `File` column holds the permanent audit-file reference.
- **Does** record optional approval metadata (see Step 5).
- **Does not** create, regenerate, or edit any `audits/*.md` file.
- **Does not** create a new topic or run any breakdown/inspection.
- **Does not** edit `CLAUDE.md` (that is `audit-sync`'s maintenance job).
- **Does not** read or modify source code.
- **Does not** approve a topic the developer did not name or clearly intend.

## Output Contract

For one selected topic, this skill may modify only:

```text
<repository-root>/AUDIT.md   — Status (and optional metadata) of the selected topic row only
```

It writes nothing else. It reads the topic's audit file (from the `File` column) only to confirm the reference resolves — it never rewrites it.

## Core Workflow

1. Determine the repository root (confirm the one already established in the conversation; do not guess).
2. Read `AUDIT.md` and locate the `## Audit Topics` table.
3. Select the topic to approve:
   - If the developer named a topic, use it.
   - Otherwise default to the topic `audit-breakdown` most recently drafted in this conversation.
   - If neither is available, list the `Draft` topics and ask which one is approved.
4. Validate the selected topic (see Step 4). If it is not in `Draft`, stop and report — do not force a transition.
5. Confirm the `File` reference resolves to an existing audit file.
6. Update only that topic's row: `Status` `Draft` -> `Approved`, plus optional metadata (Step 5).
7. Report completion (Step 6). Do not generate a new topic and do not continue on your own — the agent decides whether to loop.

## Step 4: Validate the Draft

Before changing anything, confirm all of the following for the selected topic:

- The topic exists in the `## Audit Topics` table.
- Its `Status` is exactly `Draft`.
- Its `File` column is a real path (not `Not created yet`) pointing to an existing `audits/<slug>/<slug>-audit.md`.

Stop and report without writing if:

| Situation | Action |
|-----------|--------|
| Status is `Pending Breakdown` | Report that the topic has no Draft yet — run `audit-breakdown` first. |
| Status is already `Approved` | Report it is already approved; make no change. |
| `File` is `Not created yet` or missing | Report the inconsistency; do not approve. |
| Referenced audit file does not exist | Report the broken reference; do not approve. |

Only the developer approves audits. Never infer approval from a topic being old, complete-looking, or previously discussed.

## Step 5: Update AUDIT.md

Change only the selected topic row.

From:

```markdown
| <n> | Draft | <Topic> | <Priority> | audits/<slug>/<slug>-audit.md | <Notes> |
```

To:

```markdown
| <n> | Approved | <Topic> | <Priority> | audits/<slug>/<slug>-audit.md | <Notes> |
```

Rules:

- Change only the `Status` cell (and optional metadata below). Never alter unrelated rows.
- Never reorder topics.
- Keep the `File` reference exactly as `audit-breakdown` wrote it — this is the permanent reference. Do not recompute or rename it.
- Do not add links for files that do not exist.

**Optional approval metadata:** if an approval date is known from the conversation, append it to the `Notes` cell as `Approved <YYYY-MM-DD>` (append; do not overwrite existing notes). Do not add a new table column, and do not fabricate a date if none is available.

## Step 6: Completion Report

After approving the one selected topic, report:

```text
Audit approve complete.

Topic finalized:
  ✓ <Topic> — Draft → Approved

File written or updated:
  ✓ <repository-root>/AUDIT.md — <Topic> row only

Topic status:
  Approved

Remaining:
  Pending Breakdown: <count>
  Draft: <count>

Next:
  <If Pending Breakdown remain: "The agent may now break down the next topic.">
  <If none remain and no Drafts: "All topics processed — Stage 3 is complete.">
```

The agent reads this report (and the after-audit-approve hook) to decide whether to invoke `audit-breakdown` for the next topic.

## Hard Constraints

- Finalize exactly one topic per run.
- Only transition a topic that is currently `Draft`.
- Never mark a topic Approved unless the developer named it or it is the Draft just produced for their review.
- Never generate, regenerate, or edit any audit document or create a new topic.
- Never edit `CLAUDE.md` — documentation sync is `audit-sync`'s job.
- Never modify source code.
- Only modify the `Status` (and optional `Notes` metadata) of the one selected topic row in `AUDIT.md`.
- Never recompute or rename the `File` reference.
- Never continue to the next topic yourself — report completion and let the agent orchestrate the loop.
- Never assume the current working directory is the target repository. Operate only under the absolute `<TARGET_ROOT>` passed by the orchestrator; never resolve the root from CWD or `git rev-parse --show-toplevel`, and never write to any path containing `.claude/worktrees/`. If the provided root contains that segment, stop and report instead of writing.
