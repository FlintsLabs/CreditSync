# Tmux Spark Delegation Policy Design

## Purpose

Add a repository-level agent policy that keeps architecture, specification, and detailed implementation planning in the user's currently selected model while delegating approved long-running implementation work to a Codex CLI session in tmux using `gpt-5.3-codex-spark`.

The policy is an orchestration rule only. It does not change CreditSync application behavior, financial contracts, production deployment, or MCP tool behavior.

## Triggering Rules

The current task agent remains the orchestrator.

- An explicit request to use tmux always triggers tmux delegation when Codex CLI and tmux are available.
- Without an explicit tmux request, delegation is automatic only for substantial implementation work: multi-subsystem or multi-file changes, migrations, long verification suites, work expected to need several implementation/review cycles, or work that should survive a disconnected client.
- Short read-only checks, explanations, reviews, status requests, and narrowly scoped edits remain in the current task.
- Delegation does not broaden authority. Destructive, production, external-write, or otherwise approval-gated actions still require the same authorization they would require outside tmux.

## Planning and Model Selection

The user-selected model in the current task owns discovery, clarification, design, specification, and the detailed implementation plan.

Before implementation delegation, the orchestrator must provide the worker with an approved, concrete plan containing:

- the repository and isolated worktree path;
- the target branch and integration target;
- paths to the approved spec and implementation plan;
- task scope, acceptance criteria, ordered implementation steps, and verification gates;
- relevant `AGENTS.md` rules, financial invariants, data-safety restrictions, and dirty-file ownership;
- explicit exclusions such as production deployment when not authorized.

The implementation worker starts with `gpt-5.3-codex-spark`. If that model is unavailable, rejected, or exhausted, the orchestrator may restart or continue the work with the model selected for the current task. The fallback and reason must be reported to the user; no unrelated model should be selected silently.

## Tmux Session Lifecycle

Use a stable, descriptive session name derived from the project and task, for example `creditsync-<short-task-name>`. Reuse an existing session only when its repository, branch, worktree, and objective match exactly; otherwise create a new session.

The tmux worker must run from the isolated worktree whenever isolation is appropriate. Existing user changes in another checkout are out of scope and must not be stashed, committed, reset, or overwritten by the worker.

The orchestrator must tell the user:

- the tmux session name;
- the worktree and branch;
- the implementation model, including any fallback;
- whether the session is safe to leave running after the client disconnects.

## Supervision and Communication

Tmux delegation is supervised, not fire-and-forget.

- The orchestrator periodically inspects the session, Git status, commits, tests, and approval prompts.
- Questions or blockers from the worker are relayed with enough context for a human decision.
- A worker that repeatedly waits, loops, or reports unchanged state must be diagnosed; the orchestrator must not keep claiming useful progress without evidence.
- User messages that change scope are forwarded to the active session when additive, or interrupt and replace the old objective when they supersede it.
- Status reports distinguish implementation progress, committed work, verification, integration, push, and deployment.

## Completion Contract

A tmux worker's final message is not proof of completion. Before reporting success, the orchestrator must independently verify:

1. the intended branch contains the expected commits;
2. the worktree has no unexplained tracked changes;
3. required tests and validation gates passed at the reported HEAD;
4. the target branch contains the feature when integration was requested;
5. preserved user changes are still present;
6. push or deployment occurred only when explicitly requested and authorized.

If implementation is complete only on a feature branch, the status must say so plainly. The orchestrator must not say "merged" until Git ancestry proves the target branch contains the feature.

## Failure and Recovery

- If tmux or Codex CLI is unavailable, report the limitation and continue locally only when that remains consistent with the user's request.
- If `gpt-5.3-codex-spark` fails, use the current task model as the approved fallback and record the transition in the status update.
- If a worker corrupts or conflicts with unrelated state, stop it and preserve recoverable evidence before attempting repair.
- If tests expose a real defect, return to the approved plan's debugging/review workflow rather than weakening tests or declaring the failure flaky without evidence.

## AGENTS.md Change

Implementation adds a concise `Tmux Delegation and Model Routing` section to the repository `AGENTS.md`. It should encode the rules above without embedding secrets, machine-specific credentials, or a permanently running session. No helper script or daemon is required for the initial policy.

## Verification

Because this is a documentation-only agent-policy change, verification consists of:

- checking the model flag against local `codex --help` (`--model`/`-m`);
- reviewing the policy for trigger, fallback, isolation, supervision, and completion requirements;
- scanning for contradictory instructions elsewhere in `AGENTS.md`;
- running `git diff --check` and confirming only the intended documentation files are committed.
