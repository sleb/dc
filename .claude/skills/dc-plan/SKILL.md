---
name: dc-plan
description: Create a reviewed execution plan for a Deep Cuts GitHub issue (one step = one PR). Enforces strict TDD, ties the plan to the issue's acceptance criteria, and keeps designs and docs current. Use when asked to plan, or "create an execution plan for", GH issue #N. Produces a plan artifact for review, then posts it to the issue once approved. Does not start implementation.
argument-hint: <issue number>
---

# dc-plan: execution plan for a Deep Cuts issue

Plan one step issue (`#$ARGUMENTS`). Output is a reviewed plan, not code. Do not start any implementation, provisioning or branch work until the user asks.

Every plan must:
1. Enforce strict TDD (red, green, refactor, no production change without a failing test or check first).
2. Meet the issue's acceptance criteria, or propose a change to them for the user to approve.
3. Keep every design and doc current as part of the work (deviation, new feature, new script).

## 1. Gather context (read-only)

- `gh issue view N --json title,body,labels,comments`. If `gh` returns nothing, retry with `2>&1`. If you hit the API rate limit, stop and use `ScheduleWakeup`, don't loop.
- Read the LLD sections the issue's "Implements" line names, plus the "Interfaces to other LLDs" table and Open questions of each LLD touched. Read the HLD and tech-stack only for the parts the LLDs defer to.
- Read the tracking issue (the "Deep Cuts execution plan", currently #54) for principles, milestones and decision issues.
- Read the issues this one is blocked by and the ones it blocks. A plan must not assume anything a blocker hasn't delivered, and must not collide with what the next issue scaffolds.
- List open `decision` issues for this milestone. Say which this step answers fully, partly, or not at all.
- Look at what exists in the repo (`git ls-files`, `.github`, `package.json`). The test approach depends on it.

## 2. Choose how TDD applies

Pick the mapping that fits the issue, and state it at the top of the plan.

- **Code with a test runner available** (engine, projector, store, api, web): red is a failing `bun test` / emulator / rules / Playwright test written first and committed first; green is the minimum code; refactor keeps tests green. One test at a time for pure logic; property tests (fast-check) for E/X/PJ invariants named in the LLD. Respect the checks that ship with the work: a rules denial test for every new collection (P10), an `exports.json` entry for every new export (P7).
- **Infrastructure or setup with no code yet** (cloud, CI, config): the test is a read-only verification script that asserts each item of the LLD checklist. Write it first, run it against the empty state, and require every check to fail for the right reason (not by script error). Provision until it passes. Use plain bash if the Bun workspace doesn't exist yet. Add mutation checks: deliberately break the riskiest items, confirm red, restore. Say what the checks cannot prove and which later step does.
- **Docs-only**: the test is a checklist of claims cross-checked against the LLDs; keep it short.

Always include a "Test the test" step for the riskiest seam, and an idempotence or re-run step when the work is a script.

## 3. Acceptance criteria

Quote the issue's "Done when". If any item is vague, un-testable, or mismatched with the LLD (for example "checklist ticked" when the LLD has a table), propose a rewritten list. Each item should map to a check or test. Do not edit the issue until the user approves the rewrite. Always add a "Not proven here" line for anything that needs a later step.

## 4. Build the plan

Sections, in this order:

1. **How TDD applies** (the mapping above).
2. **Acceptance criteria** (current and proposed).
3. **Verification matrix**: ID, what is asserted, how it is checked, how it is created. For code steps this is the list of tests or properties and the LLD clause each covers.
4. **Phases**, each with a gate and a commit message:
   - Phase 0 preflight (branch `step/N.M-short-name`, prerequisites, tool versions)
   - Phase 1 red
   - Phase 2 green, in dependency order, with the checks that turn green at each step
   - Phase 3 test the test / idempotence / secret hygiene
   - Phase 4 refactor and docs (reconcile LLD text with what was actually built)
   - Phase 5 PR and close-out (`Closes #N`, comments on decision issues, unblock notes, tracking issue update)
5. **Documentation updates**: a table of doc, change, why. Always consider: the LLD section(s) implemented, open questions that this step resolves, the LLD "Interfaces to other LLDs" tables, HLD and tech-stack if a deviation exists, new READMEs for new scripts or packages, the tracking issue. Add the rule: if reality differs from an LLD, stop, amend the LLD in the same PR, note the deviation in the PR body.
6. **Risks** with mitigations, including collisions with neighbouring issues.
7. **Open questions for review**: numbered, each with a recommendation and a one-line reason. Ask only what the user must decide.

Keep the plan specific to this issue. Use real LLD IDs (P-numbers, section numbers, OQ numbers). Don't pad.

## 5. Publish for review

- Write it as an Artifact (HTML), via the Artifact tool's `quickstart` first, then write the file in the scratchpad and publish. Utilitarian design, theme-aware, readable tables, phases as ruled blocks. Title is a short name, for example "Staging Project Execution Plan".
- Tell the user the link, the three or four things that most need their decision, and that it is private until shared.
- The artifact receives comments. Read them with `ArtifactComments`, answer, and when a thread is settled and the plan already reflects it, resolve it. If a thread needs a plan change, edit the artifact (use `edits` on the same file path), then resolve. Leave a thread open only while a decision is outstanding. Ask what a bare "agree" refers to if the highlighted text is ambiguous.

## 6. After approval: put it on the issue

Only when the user says to:
1. If the acceptance rewrite was approved, update the issue body (`gh issue edit N --body-file`), keeping Work, Implements, Blocked by and the footer, replacing "Done when".
2. Post the plan as a `gh issue comment`, in Markdown, with phases as checkboxes. Do not link the private artifact.
3. Delete the plan artifact so we don't accumulate cruft: the issue comment is now the record. Confirm with the user first (deleting is permanent and breaks the link), then `Artifact` with `action: "delete"` and its `url`. Resolve or answer any open comment threads before deleting, since they go with it.
4. Then offer to start Phase 0 and Phase 1. Do not start until asked.

## Rules

- **Public thread hygiene.** The issue is public. Never put personal emails, billing account IDs, project numbers, tokens, or secret values in the plan, issue body, comments or commits. Use placeholders such as `<BILLING_ACCOUNT_ID>` and `<BUDGET_ALERT_EMAIL>`, and have scripts take real values as flags or env vars at run time.
- **Be honest about limits.** If a check only proves presence and not runtime behaviour, say which later step proves it. Don't claim a seam is proven.
- **Account facts matter.** A personal Google account has no GCP organization, so org policies can't be set. Ask about account facts that change the design.
- **Stay in scope.** One step is one PR. Leave other environments and neighbouring steps (for example prod, M8) out, and say so.
- **Never start work early.** Planning ends at the posted comment and the artifact cleanup.
