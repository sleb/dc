---
name: dc-ship-milestone
description: Ship a slice of a Deep Cuts milestone unattended from one orchestrating session - resolve the target steps, cut a dependency-ordered slice, then plan, implement, review and verify each step on one batch branch, ending with one PR and one report for the human to review. Use when asked to "ship a milestone", "ship all remaining steps for M5", or to batch a list of step issues.
compatibility: Needs sub-agent delegation, git, a Bun toolchain, and an authenticated `gh` CLI for the target repo.
---

# dc-ship-milestone: ship a slice of steps, one PR, one review

This skill takes one argument: a milestone (`M5`, or its title) or a list of step issues. Both are `TARGETS`. Read `../dc-ship/SKILL.md`, `../dc-ship/reference/authority.md`, `../dc-plan/SKILL.md` and `../dc-implement/SKILL.md` once. The authority reference governs your rulings and escalations; it and the ledger are the only long-lived context.

The point: the human makes one review pass at the end, not one per step. Everything before that is yours to rule and record. Keep this session small — heavy reading, writing and debugging happen in sub-agents, one per phase per step, and the batch PR body is the ledger a fresh session could resume from.

## 1. Resolve the targets (read-only)

- `gh issue list --milestone <m> --state open --json number,title,labels,body`, or `gh issue view` for each named issue. Read the tracking issue (#54) for the milestone's exit demo.
- Drop `decision` and `tracking` issues from the slice; collect them as questions the chain depends on (step 2).
- Classify each step:
  - **agent**: implementable and verifiable by an agent.
  - **hybrid**: an automatable half plus human judgement (an accessibility pass, playtest preparation and triage). Include it; do the automatable half and state plainly what is left.
  - **human-only**: nothing automatable (a real playtest, an account decision). Exclude it, name it in the report, and treat it as a slice boundary.
- Order the agent and hybrid steps by `Blocked by` (topological), ties by step number. A step blocked by a human-only step or an unresolved decision issue is a boundary, not something to attempt.
- Cut the **slice**: the largest prefix of that order within 4 steps and roughly 1500 changed lines, stopping before a human-only step. Empty slice: say so, ship nothing.
- The slice is the unit: one `batch/M<n>-<slug>` branch, one PR, one human review. The rest of the milestone is later runs.

## 2. Preflight: one interview, then unattended

Print the run plan and stop for the user's go-ahead. This is the only interruption before the report, apart from a hard block:

- targets in order, the slice boundary, and which steps are left for later slices and why;
- hybrid and human-only steps, with what you will and will not do (evidence, the "what's left for you" note);
- every unresolved decision issue or missing fact the chain needs, one question each, with options, your recommendation and a one-line reason (`../dc-ship/reference/authority.md`);
- the branch, PR title, worktree path, slice budget, `squash` merge, and that no staging deploy happens in this run — the exit demo follows the merge, through CI;
- out of scope: neighbouring steps, other environments, prod.

Ask only what the user must decide. Do not start until they say go, and ship exactly the slice you printed.

## 3. Prepare

- `git status` clean, then a dedicated worktree so the user's checkout is untouched: `git worktree add ../dc-batch-<m> -b batch/M<n>-<slug> main`, and record the base SHA.
- Push the branch and open a **draft** PR as soon as the first step has a commit, with the ledger skeleton in the body. Until then the ledger is the run plan plus the issue comments.
- **Ledger**: the PR body, rewritten after every step and before the next one starts. A step table (step, issue, commit range, plan-comment link, rulings, red/green, deviations, review threads, "not proven"), the question queue, the parked steps, and the step you are on. It is the only durable state.

## 4. Loop over the slice

For each step in slice order, with the batch tip green:

1. **Plan.** One `general-purpose` sub-agent running `dc-plan` in batch mode: brief it with the issue, the base branch and SHA, and the batch constraints (names, data shapes, interfaces, doc and PR conventions the slice has already settled). Autonomous: no artifact, no review wait; it returns the draft and its open questions, you rule, then you resume it to post the plan comment. Check the posted comment for the base line, TDD mapping, verification matrix, phases, docs table and "Not proven here". Do not let it branch or implement.
2. **Implement.** A second sub-agent running `dc-implement` in batch mode: its base is the batch tip, its commits are prefixed `#N:`, it opens no PR and closes nothing, and it parks instead of leaving the branch red. It returns the short report. It does not review.
3. **Review.** A fresh sub-agent reviews only this step's range (`code-review` at high effort on `<base>..<head>`, or your agent's review tooling) and posts threads that start `Step <N.M> — <title>`. Rule on each, fix or decline with the reason, re-run the gates, resolve. This is the per-step cadence, and it happens before the next step starts.
4. **Gate.** On the batch tip: `bun run lint`, `bun run typecheck`, `bun run test`, whichever of `test:rules`, `test:web`, `test:hosting`, `test:integration` the slice touches, and `bun scripts/scan-secrets.ts`. A red tip stops the run; never start the next step on top of it.
5. **Ledger.** Record the step. Re-read the next step's issue and plan: if an earlier ruling or deviation invalidates it (a data shape, a public interface, a name), re-plan it now and say why, or stop if that decision is the user's.

Budget: two review rounds per step and three gate attempts; past that, stop the run and report rather than thrash.

## 5. Integration phase

On the final tip, before the report:

- the automatable part of the milestone's exit demo against the emulators (`test:integration`, `test:hosting`, `test:web` as the slice applies) — the demo itself is the human's job after merge, so this is the honest half;
- `bun run build:web` for staging mode;
- a short written manual script for the human: after merge, on which URL, what to do, what to expect, and which observations the tests cannot make.

## 6. Finalise

- One cross-step review of the whole diff, by a fresh sub-agent; the seams between steps are what it is for. Rule, fix, resolve.
- Reconcile the docs across the slice: every LLD section touched, open questions resolved, interface tables. The PR body carries the docs table and the deviations.
- Rewrite the PR body as the delivery document: what shipped per step, the step table with links, the rulings, the questions and how each was settled or left, the review threads, what is not proven and which step proves it, the human-only steps, the manual script, and the revert note per step (a step can be dropped only if nothing after it depends on it).
- Mark the PR ready; update the tracking issue once; comment on each step issue: `Implemented on <branch> as <range>; the batch PR #P closes it.` Do not close them. Leave the worktree in place for the review and say where it is.

## 7. Report

Short, mirroring `dc-ship`: the PR link and checks; **the rulings most worth a look** (a table: step, question, ruling, reason); escalations and parked steps with what is needed; the step table with statuses; what is not proven and which step proves it; what was skipped as human-only and the manual script; the re-evaluation note — if two or more steps were parked, propose the harder stop rule (stop the run at the first user-owned question) for the next run. Offer the merge; do not merge.

## 8. Merge

On the user's word: `gh pr merge <P> --squash --delete-branch`, confirm every issue in the step table closed, remove the worktree (`git worktree remove ../dc-batch-<m>`), comment once on the tracking issue, and say what CI's staging deploy now proves and what the human's exit demo still needs.

## Rules

- One slice, one PR, one review. Never push to `main` and never merge another PR into the slice.
- The step is the unit: its commits, plan comment, review threads, ledger row and issue comment. Never fold two steps into one row.
- A parked step leaves nothing behind: `git reset --hard <last green>` and the attempt on `attempt/N.M`.
- Never claim a seam is proven that only a later step proves; a hybrid step's report says "proves X, does not prove Y".
- Public-thread hygiene applies to the PR body, the ledger, the issue comments and the commits.
- Sub-agents cannot ask the user anything: a step that needs the user is parked and reported.
