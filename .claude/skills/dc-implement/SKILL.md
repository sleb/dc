---
name: dc-implement
description: Implement a Deep Cuts GitHub issue (one step = one PR) by executing the approved plan comment on the issue. Strict TDD (red, green, refactor), keeps LLDs and docs current, runs a review pass, and opens the PR. Use when asked to implement, or "do", GH issue #N. Merges only when told.
argument-hint: <issue number>
---

# dc-implement: execute a Deep Cuts step issue

Implement `#$ARGUMENTS`. The plan comes from `/dc-plan`, posted as an issue comment. Follow it; do not re-plan. If there is no plan comment, say so and offer to run `/dc-plan` first, unless the issue is trivial.

## 0. Preflight

- `gh issue view N --comments`. Read the plan comment, "Done when", "Implements" and "Blocked by". Read the LLD sections named. Read `.claude/skills/dc-plan/SKILL.md` for the TDD mapping the plan used.
- Check tools before anything else (`command -v`, `--version`, login state). If a CLI or login is missing, stop and tell the user exactly what to run (`! <command>` for interactive logins). Install what you can (`brew`, `npm -g`) and report versions; they get pinned in the README.
- Ask only for facts you cannot derive and that are the user's to choose: which billing account, which email, an amount. Offer the one candidate you found rather than an open question. Do not ask again for things already answered; pick a sensible default and say so in the PR (for example, budget alerts go to billing admins when no email was given).
- Branch from `main`: `step/N.M-short-name`, as the plan names it. Never commit to `main`.

## 1. Red

Write the test first and commit it alone (`Add <thing> (red: ...)`).
- Code steps: failing `bun test` / emulator / rules / Playwright tests, one at a time for pure logic.
- Infra steps: a read-only verification script that asserts every checklist item. Run it against the empty state and require each check to fail for a stated reason, not a script error. A check that legitimately passes while empty (nothing to leak yet) is fine; say so in the PR.
- Make verification scripts robust from the start: `exec </dev/null` and `CLOUDSDK_CORE_DISABLE_PROMPTS=1` so a prompt fails instead of hanging; every check prints reasons; never print a secret value.

## 2. Green

Do the plan's phases in dependency order. After each, re-run the verification and say which checks turned green.
- Make provisioning idempotent and re-runnable from the first version. Never overwrite a committed file that may have been tuned; create only if absent.
- Generate secrets and pipe them (`openssl rand ... | gcloud secrets create`, `gh secret set`); never echo them, pass them as arguments, or write them to disk. Store a secret's only copy before registering the thing that depends on it, so a failure leaves nothing orphaned.
- Run long or possibly-hanging commands with output going to a file in the scratchpad, and bound them. If a command hangs, look for a prompt before retrying; kill strays.
- When a CLI or API behaves differently from the LLD (wrong subcommand, batch limit, propagation delay, a default resource that breaks an "exactly" claim), do not work around it silently: fix the script, note the deviation for the LLD edit and the PR body.
- macOS: `sed -i` and `timeout` behave differently or are missing. Use `python3` for multi-line edits.
- Prefer a REST call or CLI over a console step, and prove it. If something genuinely needs the human (a login, a billing decision), stop and say exactly what.
- Actions that spend money, change shared cloud state or touch GitHub settings are in scope only as far as the plan says. Anything beyond it, ask.

## 3. Test the test

Do what the plan says: break the riskiest items on purpose (remove a grant, disable a setting, drop a policy), confirm the check goes red for the right reason, restore, confirm green. Then run the full provisioning again and confirm it changes nothing. Scan transcripts and the branch for secrets.

## 4. Docs

Reconcile the LLD sections, open questions, interface tables, and any README with what was actually built, in the same PR. Replace claims that proved false. Mark resolved open questions "Resolved (issue #N)" with the evidence (cite a source for facts you looked up). Say plainly what is unverified and which later step proves it. New scripts or packages get a README. Keep the public thread clean: no billing IDs, project numbers, tokens or personal emails in docs, commits, issue text or PR text.

## 5. Review before the PR

Standalone: run `/code-review high` on the branch (it runs in the background and returns a list of findings). Fix every real finding, including the nits that are cheap and honest to fix; for any you decline, say why in the PR. Re-run verification and the idempotence pass after the fixes.

Launched by `/dc-ship` (a sub-agent brief says so): do not run the review yourself. Open the PR, report, and stay resumable. The orchestrator runs the review, rules on the findings and sends them back as a message; fix what it says to fix, re-run verification and the idempotence pass, push, and add a "Review" section to the PR body (fixed, declined and why).

## 6. PR and close-out

- Commit in logical steps (red, then green plus docs, then review fixes). No attribution lines. Push the branch.
- Open the PR with `gh pr create --body-file` (body in the scratchpad), starting with `Closes #N`. Include: what changed; the red and green transcripts (paste the real output); mutation and idempotence results; deviations found and the LLD edits; a "Not proven here" list with the step that proves each item.
- Post any interim comments the plan calls for on neighbouring issues (for example a decision issue that stays open), as facts, not decisions.
- Update the tracking issue only if there is something to tick or a decision changed.
- Tell the user the PR link, the checks result, what they might not expect (defaults you chose, deviations), and what is not proven.

## 7. Merge

Only when the user says to. `gh pr merge N --squash --delete-branch`, then `git checkout main && git pull`, confirm the issue closed, and say what is now unblocked.

## Rules

- One step, one PR. Stay in scope; leave other environments and neighbouring steps alone and say so.
- Never claim a seam is proven that only a later step can prove.
- If an action is outward-facing or hard to reverse and the plan did not authorize it, confirm first.
