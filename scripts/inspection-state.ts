/**
 * inspection-state.ts
 *
 * Deterministic helper that owns the Ono Project Inspector orchestration
 * state file at `<repo>/.ono/state.json`. It is invoked by the internal
 * `inspection-state` skill (see skills/inspection-state/SKILL.md), which the
 * project-inspector agent calls automatically at workflow checkpoints.
 *
 * Design contract:
 * - `AUDIT.md` is the human source of truth for topic status. This file only
 *   maintains the plugin's *orchestration* state and a reconciled snapshot of
 *   the AUDIT.md topic table for fast, interruption-safe reads.
 * - PORTABLE: never stores absolute filesystem paths. Repo-relative paths and
 *   the git remote (if provided) are the only location data persisted, so the
 *   committed state file works across machines and clones.
 * - The `.ono/` directory is the shared Ono infrastructure directory; this
 *   plugin owns only `.ono/state.json` within it.
 *
 * Usage:
 *   npx ts-node inspection-state.ts <command> <repo-root> [args...]
 *
 * Commands:
 *   detect  <repo-root>                     Report inspected?/version match/resume, exit 0
 *   init    <repo-root> [gitRemote]         Create state.json if absent (idempotent)
 *   sync    <repo-root> [gitRemote] [gitHead]
 *                                           Reconcile topics/counts/stages/resume from
 *                                           AUDIT.md + on-disk artifacts, then write
 *   set-stage <repo-root> <stage> <status>  Record a stage's status, then write
 *   migrate <repo-root>                     Migrate an older schema to current, then write
 *
 * Exit codes:
 *   0 - success (for `detect`, always 0; read its JSON stdout)
 *   1 - usage error or unreadable/repo problem
 *   2 - state file present but invalid/corrupt JSON
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "fs";
import { join, sep } from "path";
import { slugify } from "./slugify";

/** Bump when the shape of state.json changes; add a migration in migrateState(). */
const STATE_SCHEMA_VERSION = 1;

type TopicStatus = "Pending Breakdown" | "Draft" | "Approved";

interface TopicState {
  index: string;
  topic: string;
  slug: string;
  status: TopicStatus | string;
  file: string; // repo-relative, exactly as AUDIT.md records it
  draftedAt: string | null;
  approvedAt: string | null;
}

interface StageState {
  status: "pending" | "in-progress" | "complete";
  completedAt: string | null;
}

interface InspectionState {
  stateSchemaVersion: number;
  plugin: { name: string; version: string };
  repository: { gitRemote: string | null; gitHead: string | null };
  createdAt: string;
  updatedAt: string;
  inspection: {
    started: boolean;
    completedStages: string[];
    currentStage: string | null;
    stage3Complete: boolean;
  };
  stages: Record<string, StageState>;
  topics: TopicState[];
  counts: { pendingBreakdown: number; draft: number; approved: number; total: number };
  resume: { nextAction: string; topic: string | null; hint: string };
  maintenance: { lastSyncAt: string | null };
  migrations: { history: Array<{ from: number; to: number; at: string }> };
}

type Counts = { pendingBreakdown: number; draft: number; approved: number; total: number };

/** A workflow + inspection stage, as declared in skills/registry.json. */
interface RegistryStage {
  id: string;
  stage: number;
  produces: string[];
  completion: "artifacts" | "topics";
}

/**
 * Load the ordered linear inspection stages from the registry. This is the
 * single source of truth for stage identity, order, produced artifacts, and
 * how completion is detected — no stage names are hardcoded in this file.
 * Portable: registry.json lives inside the plugin, resolved relative to this
 * script (works in dev and in the installed plugin cache).
 */
function loadInspectionStages(): RegistryStage[] {
  try {
    const reg = JSON.parse(readFileSync(join(__dirname, "..", "skills", "registry.json"), "utf-8"));
    return ((reg.skills ?? []) as any[])
      .filter((s) => s.enabled !== false && s.type === "workflow" && s.workflowRole === "inspection")
      .map((s) => ({
        id: String(s.id),
        stage: typeof s.stage === "number" ? s.stage : 0,
        produces: Array.isArray(s.produces) ? s.produces.map(String) : [],
        completion: s.completion === "topics" ? "topics" : "artifacts",
      }) as RegistryStage)
      .sort((a, b) => a.stage - b.stage);
  } catch {
    return [];
  }
}

/** Deterministic completion test for one stage, driven entirely by its registry declaration. */
function isStageComplete(stage: RegistryStage, repoRoot: string, counts: Counts): boolean {
  if (stage.completion === "topics") {
    // Topic-loop stage: complete when every AUDIT.md topic is Approved.
    return counts.total > 0 && counts.pendingBreakdown === 0 && counts.draft === 0;
  }
  // Artifact stage: complete when all concrete produced paths exist. Templated
  // paths (containing "<...>") are dynamic and cannot be existence-checked.
  const concrete = stage.produces.filter((p) => !p.includes("<"));
  if (concrete.length === 0) return false;
  return concrete.every((rel) => existsSync(join(repoRoot, rel)));
}

/** In-progress heuristic: partial artifacts on disk, or a topic loop that has started. */
function isStageInProgress(stage: RegistryStage, repoRoot: string, counts: Counts): boolean {
  if (stage.completion === "topics") {
    return counts.total > 0 && (counts.pendingBreakdown > 0 || counts.draft > 0);
  }
  return stage.produces.filter((p) => !p.includes("<")).some((rel) => existsSync(join(repoRoot, rel)));
}

function nowIso(): string {
  return new Date().toISOString();
}

function stateDir(repoRoot: string): string {
  return join(repoRoot, ".ono");
}
function statePath(repoRoot: string): string {
  return join(stateDir(repoRoot), "state.json");
}

/** Current plugin version, read from the plugin's own manifest (portable, relative to this script). */
function currentPluginVersion(): { name: string; version: string } {
  try {
    const manifest = JSON.parse(
      readFileSync(join(__dirname, "..", ".claude-plugin", "plugin.json"), "utf-8")
    );
    return { name: manifest.name ?? "ono-project-inspector", version: manifest.version ?? "0.0.0" };
  } catch {
    return { name: "ono-project-inspector", version: "0.0.0" };
  }
}

function readState(repoRoot: string): InspectionState | null {
  const p = statePath(repoRoot);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as InspectionState;
  } catch (err) {
    console.error(`state.json exists but is not valid JSON: ${(err as Error).message}`);
    process.exit(2);
  }
}

function writeState(repoRoot: string, state: InspectionState): void {
  const dir = stateDir(repoRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  state.updatedAt = nowIso();
  writeFileSync(statePath(repoRoot), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function firstStageHint(prefix: string): string {
  const first = loadInspectionStages()[0];
  return first ? `${prefix}Run ${first.id} (stage ${first.stage}) to begin.` : `${prefix}Run the first inspection stage to begin.`;
}

function freshState(gitRemote: string | null): InspectionState {
  const ts = nowIso();
  return {
    stateSchemaVersion: STATE_SCHEMA_VERSION,
    plugin: currentPluginVersion(),
    repository: { gitRemote: gitRemote ?? null, gitHead: null },
    createdAt: ts,
    updatedAt: ts,
    inspection: { started: false, completedStages: [], currentStage: null, stage3Complete: false },
    stages: {},
    topics: [],
    counts: { pendingBreakdown: 0, draft: 0, approved: 0, total: 0 },
    resume: { nextAction: "run-stage", topic: null, hint: firstStageHint("") },
    maintenance: { lastSyncAt: null },
    migrations: { history: [] },
  };
}

// --- AUDIT.md topic table parsing (portable, repo-relative File column) ---

function parseAuditTopics(repoRoot: string): Array<{ index: string; status: string; topic: string; file: string }> {
  const auditPath = join(repoRoot, "AUDIT.md");
  if (!existsSync(auditPath)) return [];
  const md = readFileSync(auditPath, "utf-8");
  const rows: Array<{ index: string; status: string; topic: string; file: string }> = [];
  let inTable = false;
  for (const line of md.split("\n")) {
    if (/^\|\s*#\s*\|\s*Status\s*\|\s*Topic\s*\|/i.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.trim().startsWith("|")) break;
    if (/^\|\s*-+\s*\|/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 6) continue;
    rows.push({ index: cells[0], status: cells[1], topic: cells[2], file: cells[4] });
  }
  return rows;
}

/** Rebuild the topic snapshot from AUDIT.md, preserving known timestamps and stamping new transitions. */
function reconcileTopics(prev: TopicState[], repoRoot: string): TopicState[] {
  const prevByTopic = new Map(prev.map((t) => [t.topic.toLowerCase(), t]));
  return parseAuditTopics(repoRoot).map((row) => {
    const before = prevByTopic.get(row.topic.toLowerCase());
    const draftedAt =
      before?.draftedAt ?? (row.status === "Draft" || row.status === "Approved" ? nowIso() : null);
    const approvedAt = before?.approvedAt ?? (row.status === "Approved" ? nowIso() : null);
    return {
      index: row.index,
      topic: row.topic,
      slug: slugify(row.topic),
      status: row.status,
      file: row.file,
      draftedAt,
      approvedAt,
    };
  });
}

function countTopics(topics: TopicState[]): InspectionState["counts"] {
  return {
    pendingBreakdown: topics.filter((t) => t.status === "Pending Breakdown").length,
    draft: topics.filter((t) => t.status === "Draft").length,
    approved: topics.filter((t) => t.status === "Approved").length,
    total: topics.length,
  };
}

function computeResume(state: InspectionState, stages: RegistryStage[]): InspectionState["resume"] {
  const c = state.counts;

  // 1. An open Draft awaiting review always takes priority.
  const firstDraft = state.topics.find((t) => t.status === "Draft");
  if (firstDraft) {
    return {
      nextAction: "review-draft",
      topic: firstDraft.topic,
      hint: `Review the ${firstDraft.topic} Draft, then /inspect-approve to finalize and continue.`,
    };
  }

  // 2. The current stage is the first (in registry order) not yet complete.
  const current = stages.find((st) => state.stages[st.id]?.status !== "complete");
  if (!current) {
    return { nextAction: "stage3-complete", topic: null, hint: "All inspection stages complete. /inspect-sync is available for optional maintenance." };
  }

  // 3. A topic-loop stage: break down the next pending topic, or nothing actionable.
  if (current.completion === "topics") {
    if (c.pendingBreakdown > 0) {
      const next = state.topics.find((t) => t.status === "Pending Breakdown");
      return {
        nextAction: "breakdown-next",
        topic: next?.topic ?? null,
        hint: `Break down the next Pending Breakdown topic${next ? ` (${next.topic})` : ""}.`,
      };
    }
    return { nextAction: "idle", topic: null, hint: "No topics pending." };
  }

  // 4. An artifact stage that has not yet produced its outputs.
  return { nextAction: "run-stage", topic: null, hint: `Run ${current.id} (stage ${current.stage}) next.` };
}

// --- schema migration (prepared for the future; v1 is current) ---

function migrateState(state: InspectionState): InspectionState {
  let s = state;
  while ((s.stateSchemaVersion ?? 0) < STATE_SCHEMA_VERSION) {
    const from = s.stateSchemaVersion ?? 0;
    // No historical migrations exist yet. Future example:
    //   if (from === 1) { s = { ...s, /* v1 -> v2 changes */ stateSchemaVersion: 2 }; }
    // Failsafe so an unknown/older file is not left in a broken loop:
    s = { ...s, stateSchemaVersion: from + 1 };
    s.migrations = s.migrations ?? { history: [] };
    s.migrations.history.push({ from, to: s.stateSchemaVersion, at: nowIso() });
  }
  return s;
}

// --- commands ---

function cmdDetect(repoRoot: string): void {
  const state = readState(repoRoot);
  const current = currentPluginVersion();
  if (!state) {
    console.log(
      JSON.stringify(
        { inspected: false, resume: { nextAction: "run-stage", topic: null, hint: firstStageHint("No prior inspection. ") } },
        null,
        2
      )
    );
    process.exit(0);
  }
  const versionMismatch = state.plugin.version !== current.version;
  const needsMigration = (state.stateSchemaVersion ?? 0) < STATE_SCHEMA_VERSION;
  console.log(
    JSON.stringify(
      {
        inspected: true,
        started: state.inspection.started,
        storedPluginVersion: state.plugin.version,
        currentPluginVersion: current.version,
        versionMismatch,
        storedSchemaVersion: state.stateSchemaVersion,
        currentSchemaVersion: STATE_SCHEMA_VERSION,
        needsMigration,
        completedStages: state.inspection.completedStages,
        currentStage: state.inspection.currentStage,
        stage3Complete: state.inspection.stage3Complete,
        counts: state.counts,
        resume: state.resume,
      },
      null,
      2
    )
  );
  process.exit(0);
}

function cmdInit(repoRoot: string, gitRemote: string | null): void {
  let state = readState(repoRoot);
  if (state) {
    console.log(`state.json already present (schema v${state.stateSchemaVersion}, plugin ${state.plugin.version}).`);
    process.exit(0);
  }
  state = freshState(gitRemote);
  writeState(repoRoot, state);
  console.log(`Initialized ${join(".ono", "state.json")} (schema v${STATE_SCHEMA_VERSION}, plugin ${state.plugin.version}).`);
  process.exit(0);
}

function cmdSync(repoRoot: string, gitRemote: string | null, gitHead: string | null): void {
  let state = readState(repoRoot) ?? freshState(gitRemote);
  state = migrateState(state);
  state.plugin = currentPluginVersion();
  if (gitRemote) state.repository.gitRemote = gitRemote;
  if (gitHead) state.repository.gitHead = gitHead;

  // Reconcile the topic snapshot from AUDIT.md (the human source of truth).
  state.topics = reconcileTopics(state.topics, repoRoot);
  state.counts = countTopics(state.topics);

  // Reconcile every stage's completion entirely from the registry declaration.
  const stages = loadInspectionStages();
  for (const st of stages) {
    const prev = state.stages[st.id];
    const complete = isStageComplete(st, repoRoot, state.counts);
    const status = complete
      ? "complete"
      : isStageInProgress(st, repoRoot, state.counts)
      ? "in-progress"
      : prev?.status ?? "pending";
    state.stages[st.id] = { status, completedAt: complete ? prev?.completedAt ?? nowIso() : null };
  }

  // Completed stages, current stage, and "topic loop done" all derive from registry order.
  state.inspection.completedStages = stages
    .filter((st) => state.stages[st.id]?.status === "complete")
    .map((st) => st.id);
  const firstIncomplete = stages.find((st) => state.stages[st.id]?.status !== "complete");
  state.inspection.currentStage = firstIncomplete ? firstIncomplete.id : null;
  const topicStages = stages.filter((st) => st.completion === "topics");
  state.inspection.stage3Complete =
    topicStages.length > 0 && topicStages.every((st) => state.stages[st.id]?.status === "complete");
  state.inspection.started = state.inspection.completedStages.length > 0 || state.counts.total > 0;

  state.resume = computeResume(state, stages);
  writeState(repoRoot, state);
  console.log(`Synced ${join(".ono", "state.json")}: ${JSON.stringify(state.counts)}, next=${state.resume.nextAction}.`);
  process.exit(0);
}

function cmdSetStage(repoRoot: string, stage: string, status: string): void {
  let state = readState(repoRoot) ?? freshState(null);
  state = migrateState(state);
  const valid = ["pending", "in-progress", "complete"];
  if (!valid.includes(status)) {
    console.error(`Invalid status "${status}" (expected one of ${valid.join(", ")}).`);
    process.exit(1);
  }
  const prev = state.stages[stage];
  state.stages[stage] = {
    status: status as StageState["status"],
    completedAt: status === "complete" ? prev?.completedAt ?? nowIso() : prev?.completedAt ?? null,
  };
  state.inspection.completedStages = Object.entries(state.stages)
    .filter(([, v]) => v.status === "complete")
    .map(([k]) => k);
  writeState(repoRoot, state);
  console.log(`Stage "${stage}" set to "${status}".`);
  process.exit(0);
}

function cmdMigrate(repoRoot: string): void {
  const existing = readState(repoRoot);
  if (!existing) {
    console.error("No state.json to migrate.");
    process.exit(1);
  }
  const before = existing.stateSchemaVersion ?? 0;
  const migrated = migrateState(existing);
  if (migrated.stateSchemaVersion === before) {
    console.log(`Already at schema v${before}; nothing to migrate.`);
    process.exit(0);
  }
  writeState(repoRoot, migrated);
  console.log(`Migrated schema v${before} -> v${migrated.stateSchemaVersion}.`);
  process.exit(0);
}

function main(): void {
  const [, , command, repoRoot, ...rest] = process.argv;
  if (!command || !repoRoot) {
    console.error("Usage: inspection-state.ts <detect|init|sync|set-stage|migrate> <repo-root> [args...]");
    process.exit(1);
  }
  if (!existsSync(repoRoot)) {
    console.error(`Repository root not found: ${repoRoot}`);
    process.exit(1);
  }
  // Guard (worktree safety): never own/compute state inside a Claude agent
  // worktree — that path is an ephemeral execution copy, not the developer's
  // repository. Callers must pass the resolved main-tree root
  // (scripts/resolve-repo-root.ts). `detect` is read-only, but even reading
  // from a worktree would mislead the resume pointer, so guard all commands.
  const WORKTREE_MARKER = `${sep}.claude${sep}worktrees${sep}`;
  if (realpathSync(repoRoot).includes(WORKTREE_MARKER)) {
    console.error(
      `Refusing to operate on a Claude agent worktree: ${repoRoot}\n` +
        `Pass the resolved main repository root (scripts/resolve-repo-root.ts).`
    );
    process.exit(1);
  }
  switch (command) {
    case "detect":
      return cmdDetect(repoRoot);
    case "init":
      return cmdInit(repoRoot, rest[0] ?? null);
    case "sync":
      return cmdSync(repoRoot, rest[0] ?? null, rest[1] ?? null);
    case "set-stage":
      if (!rest[0] || !rest[1]) {
        console.error("Usage: inspection-state.ts set-stage <repo-root> <stage> <status>");
        process.exit(1);
      }
      return cmdSetStage(repoRoot, rest[0], rest[1]);
    case "migrate":
      return cmdMigrate(repoRoot);
    default:
      console.error(`Unknown command "${command}".`);
      process.exit(1);
  }
}

if (require.main === module) {
  main();
}
