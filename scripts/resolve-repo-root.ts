/**
 * resolve-repo-root.ts
 *
 * Deterministic helper that resolves the *real* target repository root for the
 * Ono Project Inspector, unwrapping Claude Code agent worktrees.
 *
 * Claude Code may run an agent inside an isolated git worktree at
 *   <repo>/.claude/worktrees/agent-<id>/
 * Inside that worktree, CWD and `git rev-parse --show-toplevel` both point at
 * the worktree — itself a legitimate git root — not the developer's main
 * working tree. Writing CLAUDE.md/AUDIT.md/.ono/docs/audits there silently
 * strands them in a throwaway copy. This helper collapses that ambiguity to a
 * single authoritative absolute path. It never writes anything.
 *
 * Usage:
 *   bun scripts/resolve-repo-root.ts [candidate-path]     (default: CWD)
 *
 * Exit codes:
 *   0 - resolved a safe, non-worktree targetRoot (read its JSON stdout)
 *   1 - candidate path does not exist
 *   3 - candidate is a Claude worktree that could not be unwrapped (unsafe)
 */

import { existsSync, realpathSync } from "fs";
import { execFileSync } from "child_process";
import { resolve, sep } from "path";

const CLAUDE_WORKTREE_MARKER = `${sep}.claude${sep}worktrees${sep}`;

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** The first `worktree <path>` line of `git worktree list --porcelain` is always the main working tree. */
function mainWorktree(cwd: string): string | null {
  const out = git(["worktree", "list", "--porcelain"], cwd);
  if (!out) return null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) return line.slice("worktree ".length).trim();
  }
  return null;
}

function main(): void {
  const candidateAbs = resolve(process.argv[2] ?? process.cwd());
  if (!existsSync(candidateAbs)) {
    console.error(`Candidate path not found: ${candidateAbs}`);
    process.exit(1);
  }
  const candidate = realpathSync(candidateAbs);

  const toplevel = git(["rev-parse", "--show-toplevel"], candidate);
  const isGit = toplevel !== null;
  const isClaudeWorktree = candidate.includes(CLAUDE_WORKTREE_MARKER);
  const main = isGit ? mainWorktree(candidate) : null;

  let targetRoot = toplevel ?? candidate;
  let unwrapped = false;
  let warning: string | null = null;

  if (isClaudeWorktree) {
    if (main && existsSync(main) && !main.includes(CLAUDE_WORKTREE_MARKER)) {
      targetRoot = realpathSync(main);
      unwrapped = true;
    } else {
      warning =
        "Candidate is inside .claude/worktrees but the main working tree could not be resolved; refusing to treat the worktree as the target.";
    }
  }

  const targetIsWorktree = targetRoot.includes(CLAUDE_WORKTREE_MARKER);
  const ok = !targetIsWorktree && !warning;

  console.log(
    JSON.stringify(
      { candidate, targetRoot, isGit, isClaudeWorktree, unwrapped, mainWorktree: main, targetIsWorktree, ok, warning },
      null,
      2
    )
  );
  process.exit(ok ? 0 : 3);
}

main();
