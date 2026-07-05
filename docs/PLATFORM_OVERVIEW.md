# Ono Plugin Platform – Overview

> A high-level introduction for developers new to the project. This is not an architecture document — for component-level detail see [`docs/architecture/PLATFORM_ARCHITECTURE.md`](architecture/PLATFORM_ARCHITECTURE.md). Here we explain the concepts and the reasoning behind the platform, and how it got here.

## Vision

The goal was never to build "another Claude Code plugin." It was to build a **reusable AI workflow platform for software engineering** — a shared way to run structured, multi-stage work over a repository that is safe, resumable, auditable, and human-approved at every consequential step.

The **Ono Project Inspector** is the first thing built on that platform, but the valuable output is the platform itself: a set of conventions and small deterministic tools that any future Ono plugin can reuse instead of reinventing orchestration. What began as a single plugin evolved, decision by decision, into that platform.

---

## What We Built

### 1. Plugin Marketplace

Plugins are distributed through a dedicated marketplace repository (`ono-plugin-marketplace`) rather than shared ad-hoc. Centralized distribution means a developer adds the marketplace once and can then discover and install any Ono plugin from a single place, with versioning handled consistently. Installs use an HTTPS source, so they work on any machine without requiring SSH keys or special setup. As more plugins are added, they all appear in the same catalog with no new onboarding steps.

---

### 2. Registry-Driven Workflow

The workflow is not hardcoded anywhere. A single file, `skills/registry.json`, is the source of truth for:

- **workflow stages** — which skills exist,
- **execution order** — the `stage` ordering,
- **dependencies** — the artifacts each stage `requires`,
- **completion rules** — how a stage is considered done (`completion`), and
- **produced artifacts** — what each stage `produces`.

Because the orchestration reads this data instead of embedding a fixed sequence, adding a new **linear** workflow skill now requires only:

- creating `skills/<skill>/SKILL.md`, and
- adding one `registry.json` entry.

No edits to the Agent, to `inspection-state`, or to any script. The new stage is executed, tracked, and resumed automatically.

---

### 3. Inspection State

Every inspected repository carries a small state file at `.ono/state.json`. It is the plugin's durable memory of an inspection and stores:

- **workflow progress** and **completed stages**,
- the **current stage**,
- **resume information** (what to do next),
- the **plugin version** that last wrote it, and
- **migration information** (a state schema version, so older files can be upgraded).

There is a deliberate separation of concerns between two files:

- **`AUDIT.md` is the human source of truth** — the topic index and statuses that people read, review, and reason about.
- **`.ono/state.json` is the orchestration state** — the machine-readable record the platform uses to decide what happens next.

They never conflict: the state file *mirrors* `AUDIT.md` and never overrides it. The file is portable (no absolute paths) and committed to Git, so inspection progress is shared across the team and survives moving between machines.

---

### 4. Smart Startup

Running `/inspect` no longer blindly starts from the beginning. The plugin first analyzes the repository's state (via `inspection-state`), then presents a status summary and a tailored set of choices before touching anything. Three situations are handled:

- **No inspection exists** — offer to start a new inspection, or leave everything unchanged.
- **Inspection in progress** — show what's done, the current stage, and the recommended next action; offer to continue, review and approve the current Draft, generate the next topic, run documentation sync, or leave unchanged.
- **Inspection completed** — report completion and offer maintenance actions only.

Nothing is written until the developer chooses to start or continue, so a curious `/inspect` never changes the repository by accident.

---

### 5. Approval Workflow

Audit topics are processed one at a time through an explicit review gate:

```
audit-breakdown → Draft → Developer Review → audit-approve → Approved → Next Topic
```

`audit-breakdown` produces exactly one Draft and stops. The developer reviews it. Only when they approve does `audit-approve` mark the topic `Approved`, after which the next topic is drafted.

**Review before persistence matters** because approved findings become part of the project's permanent, shared knowledge (they are later surfaced into `CLAUDE.md`). Requiring human approval before a topic is finalized keeps that knowledge trustworthy: nothing an AI drafted becomes "official" until a person has signed off.

---

### 6. Living Project Knowledge

The platform doesn't produce a one-off report — it continuously builds a knowledge base *about* the repository, without ever modifying its source:

- **`CLAUDE.md`** — compact context every future Claude Code session reads,
- **`AUDIT.md`** — the concise audit topic index,
- **`docs/project/`** — a descriptive knowledge base (overview, components, patterns, integrations),
- **`audits/`** — one focused audit document per topic.

After a topic is approved, the `audit-sync` maintenance tool folds its key findings into managed sections of `CLAUDE.md`, so every future session automatically benefits from what previous inspections learned — the project's knowledge stays alive and current.

---

### 7. Internal Skills

The platform distinguishes two kinds of skills:

- **Workflow Skills** do the domain work a developer cares about (analysis, documentation, audit breakdown, approval, sync). They are sequenced by the Agent and gated by developer approval.
- **Internal Skills** are infrastructure. They are invoked automatically by the Agent at defined moments, have no command, and are never a workflow stage.

`inspection-state` is the primary Internal Skill: it quietly maintains `.ono/state.json` so the rest of the workflow can be resumable and version-aware, without the developer ever calling it directly.

---

### 8. Deterministic Infrastructure

Structured data is never left to LLM judgment. Anything that must be exact — file paths, table cells, JSON state, version numbers — is handled by small deterministic scripts, so the same input always yields the same result. Examples:

- **inspection-state** — reads and reconciles `.ono/state.json`,
- **audit indexing** — verifies the `AUDIT.md` topic table against fixed slug rules,
- **migrations** — upgrade an older state file to the current schema,
- **registry processing** — deriving stages, order, and completion from `registry.json`.

The LLM does the reasoning and prose; the deterministic layer does the bookkeeping. This split is what makes the platform reliable.

---

### 9. Registry as the Single Source of Truth

`registry.json` is the spine of the whole system. The same declarations drive:

- the **workflow** — which stages run and in what order,
- **inspection-state** — how completion and resume are computed, and
- **Agent execution** — how the orchestrator sequences skills and enforces gates.

Because all three read from one declarative source rather than from hardcoded logic, the platform's behavior changes by editing data, not code — and stays internally consistent by construction.

---

### 10. Plugin Platform

The **Project Inspector is the first implementation** of the Ono Plugin Platform, not the platform itself. The Agent, registry contract, internal state, hooks, and deterministic scripts are all reusable.

Future plugins are expected to reuse the same components:

- **Dev Plugin** — feature design and task preparation,
- **QA Plugin** — test inventory and coverage analysis,
- **Security Plugin** — security-surface mapping and findings,
- **Product Plugin** — product and requirements knowledge.

Each would ship its own skills and registry entries while inheriting the same orchestration, approval model, state management, and distribution — so building the second plugin is mostly declaring new skills, not rebuilding the engine.

---

## Key Innovations

The platform emerged from a series of deliberate architectural steps:

- **Registry-driven workflow** — stages, order, dependencies, and completion live in data, not code.
- **Persistent inspection state** — `.ono/state.json` gives every inspection durable, portable, version-aware memory.
- **Smart `/inspect` startup** — the plugin understands repository state and offers choices instead of blindly running.
- **Internal Skills** — a clean separation between domain workflow and auto-invoked infrastructure.
- **Review-driven knowledge creation** — nothing becomes permanent project knowledge without human approval.
- **Deterministic infrastructure** — structured state and bookkeeping handled by scripts, not LLM guesses.
- **Reusable platform architecture** — one engine, many future plugins.

---

## Final Result

The Project Inspector has evolved from a standalone Claude Code plugin into the **first implementation of the Ono Plugin Platform** — a reusable foundation for AI-assisted software-engineering workflows. Its value is no longer just "it audits a repository"; it is that the way it does so — registry-driven, resumable, review-gated, and deterministically tracked — is a platform that future Ono plugins can build on directly.
