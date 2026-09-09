# Tmux Spark Delegation Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a repository agent policy that delegates substantial approved implementation work to supervised Codex sessions in tmux using `gpt-5.3-codex-spark`, with fallback to the current task model.

**Architecture:** Keep the rule declarative in the root `AGENTS.md`; do not add a daemon or helper script. The current task agent remains responsible for planning, authorization, supervision, independent verification, and final integration, while tmux provides persistence and Spark provides the default implementation model for qualifying work.

**Tech Stack:** Markdown policy, Codex CLI (`--model`/`-m`), tmux, Git worktrees, Git verification commands.

## Global Constraints

- Explicit tmux requests always delegate when Codex CLI and tmux are available.
- Automatic delegation applies only to substantial implementation work; short checks and narrow edits stay in the current task.
- Planning remains in the user-selected current task model.
- Implementation starts with `gpt-5.3-codex-spark`; unavailable Spark falls back to the current task model and must be reported.
- Delegation never broadens production, destructive, external-write, or approval authority.
- Preserve unrelated dirty files and prefer an isolated worktree for qualifying implementation.
- Never claim completion solely from worker output; independently verify commits, worktree state, gates, ancestry, and preserved user changes.

---

### Task 1: Add and verify the tmux delegation policy

**Files:**
- Modify: `AGENTS.md`
- Modify: `CHANGELOG.md`
- Reference: `docs/superpowers/specs/2026-08-14-tmux-spark-delegation-policy-design.md`

**Interfaces:**
- Consumes: the approved design's trigger, model-routing, isolation, supervision, fallback, and completion contracts.
- Produces: a root `AGENTS.md` section titled `Tmux Delegation and Model Routing` that all repository agents can apply without a helper script.

- [ ] **Step 1: Run RED checks against the current policy**

Run:

```bash
test "$(rg -c '^## Tmux Delegation and Model Routing$' AGENTS.md)" -eq 1
rg -q 'gpt-5\.3-codex-spark' AGENTS.md
rg -q 'git merge-base --is-ancestor' AGENTS.md
```

Expected: FAIL because the section and required model/completion rules do not exist yet.

- [ ] **Step 2: Add the exact policy section to `AGENTS.md`**

Insert this section after `Runtime Preference (Bun First)` and before Docker/runtime details:

```markdown
## Tmux Delegation and Model Routing

- The current task agent owns discovery, clarification, design, specification, and the detailed implementation plan using the model selected by the user for the current task.
- If the user explicitly requests tmux, delegate implementation through tmux whenever Codex CLI and tmux are available. Without an explicit request, use tmux automatically only for substantial implementation work such as multi-subsystem or multi-file changes, migrations, long verification suites, repeated implementation/review cycles, or work that should survive client disconnection. Keep short read-only checks, explanations, reviews, status requests, and narrow edits in the current task.
- Before delegation, obtain approval for the spec and detailed implementation plan. Start the worker from an appropriate isolated worktree and pass the repository/worktree path, branch and integration target, spec/plan paths, acceptance criteria, ordered steps, required verification gates, relevant financial/data-safety rules, dirty-file ownership, and explicit scope exclusions.
- Start implementation workers with Codex CLI model `gpt-5.3-codex-spark` using `--model`/`-m`. If Spark is unavailable, rejected, or exhausted, fall back to the model selected for the current task and report the fallback and reason to the user; do not silently choose an unrelated model.
- Name tmux sessions descriptively as `<project>-<short-task-name>`. Reuse a session only when its repository, worktree, branch, and objective match exactly. Report the session name, worktree, branch, active implementation model, fallback state, and whether it is safe for the client to disconnect.
- Delegation does not broaden authority. Production, destructive, external-write, credential, approval-gated, and other sensitive actions retain their existing authorization requirements. Never embed secrets in tmux commands, prompts, logs, specs, or plans.
- Supervise tmux work instead of treating it as fire-and-forget: inspect session output, Git state, commits, tests, and approval prompts; relay blockers with context; diagnose repeated unchanged waits; and forward additive scope updates or interrupt superseded objectives.
- Treat worker completion as untrusted until independently verified. Before reporting success, confirm the expected commits, no unexplained tracked changes, all required gates at the reported HEAD, preserved user changes, and requested target integration. When merge was requested, run `git merge-base --is-ancestor <feature> <target>` and do not say merged unless it succeeds. Distinguish branch completion, integration, push, and deployment in status reports.
- If tmux or Codex CLI is unavailable, report that limitation and continue locally only when consistent with the user's request. If the worker conflicts with unrelated state, stop it and preserve recoverable evidence before repair.
```

- [ ] **Step 3: Record the implemented policy in `CHANGELOG.md`**

Add this bullet under `## v0.3.12 - 2026-08-14` → `### Changed` (create the heading if absent):

```markdown
- Routed substantial approved implementation work through supervised tmux Codex sessions using `gpt-5.3-codex-spark`, with current-model fallback, isolated worktree handoff, explicit authority boundaries, progress supervision, and independent completion/integration verification.
```

- [ ] **Step 4: Run GREEN policy checks**

Run:

```bash
test "$(rg -c '^## Tmux Delegation and Model Routing$' AGENTS.md)" -eq 1
rg -q 'gpt-5\.3-codex-spark' AGENTS.md
rg -q -- '--model.*/-m|--model`/`-m' AGENTS.md
rg -q 'git merge-base --is-ancestor' AGENTS.md
rg -q 'Delegation does not broaden authority' AGENTS.md
rg -q 'Supervise tmux work' AGENTS.md
rg -q 'fall back to the model selected for the current task' AGENTS.md
codex --help | rg -q -- '--model <MODEL>'
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 5: Review scope and contradictions**

Run:

```bash
git diff -- AGENTS.md CHANGELOG.md
git status --short
```

Expected: only `AGENTS.md` and `CHANGELOG.md` are modified for implementation; the policy does not weaken existing financial, MCP, commit, verification, production, or destructive-action rules.

- [ ] **Step 6: Commit the implementation**

Run:

```bash
git add AGENTS.md CHANGELOG.md
git diff --cached --check
git commit -m "docs: route substantial work through tmux spark"
```

Expected: one changelog-inclusive documentation commit with no application or infrastructure files.

- [ ] **Step 7: Verify the committed result**

Run:

```bash
git status --short --branch
git show --stat --oneline HEAD
git show HEAD:AGENTS.md | rg -q '^## Tmux Delegation and Model Routing$'
git show HEAD:AGENTS.md | rg -q 'gpt-5\.3-codex-spark'
```

Expected: clean worktree, the commit contains only `AGENTS.md` and `CHANGELOG.md`, and both policy assertions pass.
