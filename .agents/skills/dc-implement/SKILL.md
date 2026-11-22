---
name: dc-implement
description: Implement a Deep Cuts GitHub issue (one step = one PR) by executing the approved plan comment on the issue. Strict TDD (red, green, refactor), keeps LLDs and docs current, runs a review pass, and opens the PR. Use when asked to implement, or "do", GH issue #N. Merges only when told.
compatibility: Needs git, the Bun toolchain, and an authenticated `gh` CLI for the target repo.
---

# dc-implement: execute a Deep Cuts step issue

This skill takes one argument, a GitHub issue number; it is called `N` below (read it from the invocation arguments, `$ARGUMENTS` in agents that expose it).

Implement `#N`. The plan comes from the dc-plan skill, posted as an issue comment. Follow it; do not re-plan. If there is no plan comment, say so and offer to run the dc-plan skill first, unless the issue is trivial.

## Batch mode

`dc-ship-milestone` runs this skill per step and briefs you with the base branch (`batch/M<n>-<slug>`), its tip SHA, and the ledger in the batch PR body. Then:

- Check out the base the brief names. Do not branch from `main`, do not merge `main` into the batch branch mid-slice, and if `HEAD` is not that tip, stop and report.
- Prefix every commit with the issue: `#47: red ...`, `#47: green ...`. The step is the unit, and its commit range has to stay identifiable in the batch.
- Keep the batch tip green. Run the whole gate set on the tip, not just this step's tests, before you report: an earlier step breaking is yours now.
- Open no PR and close no issue. Push, rewrite your step's section of the ledger in the batch PR body, and comment on the issue that it is implemented on the branch and the batch PR closes it.
- Park rather than rot: if the step needs something only the user can supply, `git reset --hard <base>`, push the attempt as `attempt/N.M`, and report. Half-finished work never becomes the next step's base.
- The orchestrator reviews your range and sends the findings; do not run the review yourself.

## 0. Preflight

- `gh issue view N --comments`. Read the plan comment, "Done when", "Implements" and "Blocked by". Read the LLD sections named. Read `../dc-plan/SKILL.md` (the dc-plan skill) for the TDD mapping the plan used.
- Check tools before anything else (`command -v`, `--version`, login state). If a CLI or login is missing, stop and tell the user exactly what to run, including the command for interactive logins they must run themselves. Install what you can (`brew`, `npm -g`) and report versions; they get pinned in the README.
- Ask only for facts you cannot derive and that are the user's to choose: which billing account, which email, an amount. Offer the one candidate you found rather than an open question. Do not ask again for things already answered; pick a sensible default and say so in the PR (for example, budget alerts go to billing admins when no email was given).
- Branch from `main`: `step/N.M-short-name`, as the plan names it; in batch mode, work on the batch branch the brief names, which is already checked out. Never commit to `main`.

## 1. Red

Write the test first and commit it alone (`Add <thing> (red: ...)`, prefixed `#N:` in batch mode).
- Code steps: failing `bun test` / emulator / rules / Playwright tests, one at a time for pure logic.
- Infra steps: a read-only verification script that asserts every checklist item. Run it against the empty state and require each check to fail for a stated reason, not a script error. A check that legitimately passes while empty (nothing to leak yet) is fine; say so in the PR.
- Make verification scripts robust from the start: `exec </dev/null` and `CLOUDSDK_CORE_DISABLE_PROMPTS=1` so a prompt fails instead of hanging; every check prints reasons; never print a secret value.

## 2. Green

Do the plan's phases in dependency order. After each, re-run the verification and say which checks turned green.
- Make provisioning idempotent and re-runnable from the first version. Never overwrite a committed file that may have been tuned; create only if absent.
- Generate secrets and pipe them (`openssl rand ... | gcloud secrets create`, `gh secret set`); never echo them, pass them as arguments, or write them to disk. Store a secret's only copy before registering the thing that depends on it, so a failure leaves nothing orphaned.
- Run long or possibly-hanging commands with output going to a file in a scratch directory outside the repo, and bound them. If a command hangs, look for a prompt before retrying; kill strays.
- Keep the branch green as a whole: at the end of the step, `bun run lint`, `bun run typecheck`, `bun run test`, the emulator suites the plan names, and `bun scripts/scan-secrets.ts` all pass on the tip you are leaving behind.
- When a CLI or API behaves differently from the LLD (wrong subcommand, batch limit, propagation delay, a default resource that breaks an "exactly" claim), do not work around it silently: fix the script, note the deviation for the LLD edit and the PR body.
- macOS: `sed -i` and `timeout` behave differently or are missing. Use `python3` for multi-line edits.
- Prefer a REST call or CLI over a console step, and prove it. If something genuinely needs the human (a login, a billing decision), stop and say exactly what.
- Actions that spend money, change shared cloud state or touch GitHub settings are in scope only as far as the plan says. Anything beyond it, ask.

## 3. Test the test

Do what the plan says: break the riskiest items on purpose (remove a grant, disable a setting, drop a policy), confirm the check goes red for the right reason, restore, confirm green. Then run the full provisioning again and confirm it changes nothing. Scan transcripts and the branch for secrets.

## 4. Docs

Reconcile the LLD sections, open questions, interface tables, and any README with what was actually built, in the same PR. Replace claims that proved false. Mark resolved open questions "Resolved (issue #N)" with the evidence (cite a source for facts you looked up). Say plainly what is unverified and which later step proves it. New scripts or packages get a README. Keep the public thread clean: no billing IDs, project numbers, tokens or personal emails in docs, commits, issue text or PR text.

## 5. Review before the PR

Standalone: run the `code-review` skill at high effort on the branch, or your agent's review tooling if it has none (a background review that returns a list of findings). Fix every real finding, including the nits that are cheap and honest to fix; for any you decline, say why in the PR. Re-run verification and the idempotence pass after the fixes.

Launched as a sub-agent by the dc-ship or dc-ship-milestone skill (the brief says so): do not run the review yourself. Open the PR, or in batch mode push the batch branch, and stay resumable. The orchestrator runs the review, rules on the findings and sends them back as a message; the findings are PR review threads and the message names which to fix. Read each thread for its location and context, fix it, reply on the thread with the commit SHA and what changed (`Fixed in <sha>: ...`), and do not resolve it (the orchestrator resolves). Re-run verification and the idempotence pass, push, and add a short "Review" section to the PR body — the step's ledger row in batch mode — linking the threads (fixed, declined and why). In batch mode the review covers only your step's commit range, its threads start `Step <N.M> — <title>`, and the batch tip must be green again after the fixes.

## 6. PR and close-out

- Commit in logical steps (red, then green plus docs, then review fixes). No attribution lines. Push the branch.
- In batch mode there is no `gh pr create`. Push the batch branch; then rewrite your step's section of the ledger in the batch PR body (commit range, red and green transcripts, mutation and idempotence results, deviations and rulings, review threads, "Not proven here") and post one issue comment: `Implemented on <branch> as <range>; the batch PR #P closes it.` Do not close the issue and do not put `Closes` in the comment; the batch PR's step table is the record and its `Closes` list fires at the end. If the issue says one step is one PR, the batch comment supersedes it for this run.
- Standalone, open the PR with `gh pr create --body-file` (body in a scratch file), starting with `Closes #N`. Include: what changed; the red and green transcripts (paste the real output); mutation and idempotence results; deviations found and the LLD edits; a "Not proven here" list with the step that proves each item.
- Post any interim comments the plan calls for on neighbouring issues (for example a decision issue that stays open), as facts, not decisions.
- Update the tracking issue only if there is something to tick or a decision changed.
- Tell the user the PR link, the checks result, what they might not expect (defaults you chose, deviations), and what is not proven.

## 7. Merge

Only when the user says to, and never in batch mode (the batch PR is merged once, by the orchestrator, at the end). `gh pr merge N --squash --delete-branch`, then `git checkout main && git pull`, confirm the issue closed, and say what is now unblocked.

## Rules

- One step is one PR, or one commit range in the batch PR. Stay in scope; leave other environments and neighbouring steps alone and say so.
- Never claim a seam is proven that only a later step can prove.
- If an action is outward-facing or hard to reverse and the plan did not authorize it, confirm first.
