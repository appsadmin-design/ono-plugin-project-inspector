/**
 * verify-artifacts.ts
 *
 * Deterministic Option-3 backstop: independently confirm that a stage's
 * produced artifacts exist at the *real* target repository root — never
 * trusting a skill's textual "written" report — and detect the specific
 * failure where artifacts were written only inside a Claude agent worktree.
 *
 * Usage:
 *   bun scripts/verify-artifacts.ts <repo-root> <relpath> [relpath...]
 *
 * - Templated paths containing "<" are skipped; pass the concrete resolved
 *   path (e.g. audits/architecture/architecture-audit.md) instead.
 * - Exit 0 => every concrete artifact exists at <repo-root>, no leak.
 * - Exit 1 => usage / missing repo-root.
 * - Exit 2 => <repo-root> is itself inside .claude/worktrees (wrong root).
 * - Exit 4 => an artifact is missing at the real root (JSON `leakedTo` flags a
 *             stray copy found under .claude/worktrees — the exact bug).
 * Never writes anything.
 */

import { existsSync, readdirSync, realpathSync } from "fs";
import { join, sep } from "path";

const MARKER = `${sep}.claude${sep}worktrees${sep}`;

function leakedInWorktree(repoRoot: string, rel: string): string | null {
  const wtDir = join(repoRoot, ".claude", "worktrees");
  if (!existsSync(wtDir)) return null;
  for (const entry of readdirSync(wtDir)) {
    const candidate = join(wtDir, entry, rel);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function main(): void {
  const [, , repoRootArg, ...rels] = process.argv;
  if (!repoRootArg || rels.length === 0) {
    console.error("Usage: verify-artifacts.ts <repo-root> <relpath> [relpath...]");
    process.exit(1);
  }
  if (!existsSync(repoRootArg)) {
    console.error(`Repository root not found: ${repoRootArg}`);
    process.exit(1);
  }
  const repoRoot = realpathSync(repoRootArg);

  if (repoRoot.includes(MARKER)) {
    console.log(JSON.stringify({ ok: false, reason: "target-root-is-worktree", repoRoot }, null, 2));
    process.exit(2);
  }

  const concrete = rels.filter((r) => !r.includes("<"));
  const checked = concrete.map((rel) => {
    const presentAtRoot = existsSync(join(repoRoot, rel));
    return { artifact: rel, presentAtRoot, leakedTo: presentAtRoot ? null : leakedInWorktree(repoRoot, rel) };
  });

  const missing = checked.filter((r) => !r.presentAtRoot);
  const ok = missing.length === 0;
  console.log(JSON.stringify({ ok, repoRoot, checked, missing }, null, 2));
  process.exit(ok ? 0 : 4);
}

main();
