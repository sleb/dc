---
name: dc-ship
description: Take a Deep Cuts step issue from plan to open PR with minimal main-session context. Runs /dc-plan and /dc-implement as sub-agents, rules on open questions itself, runs /code-review itself and rules on the findings, verifies the result, and reports. Stops for the user only on genuinely user-owned decisions, and merges only when told. Use when asked to "ship", or do plan and implement for, GH issue #N.
argument-hint: <issue number>
---

# dc-ship: plan, implement and review one Deep Cuts step issue

Ship `#$ARGUMENTS`. You are the orchestrator. The point is to keep this session small: the heavy reading, writing and debugging happens in sub-agents, and you see their reports and check their artifacts. The GitHub issue is the handoff between phases (plan comment in, PR out), so no context needs to be passed along.

Read `.claude/skills/dc-plan/SKILL.md` and `.claude/skills/dc-implement/SKILL.md` once so you can brief the sub-agents and judge their output.

## Authority

The user's invocation of `/dc-ship` authorizes everything `/dc-plan` and `/dc-implement` would do for this issue, including rewriting the issue's "Done when", posting the plan comment, pushing the branch and opening the PR. It does not authorize merging.

**Rule it yourself, report it later.** Open questions, acceptance rewrites, deviations from an LLD, review findings: decide them using the LLD, the HLD, the tracking issue and the user's earlier decisions, pick the option you would recommend, and record the question, the ruling and the reason. The user reads these in the final report and can overturn any.

**Escalate only when a ruling is not yours to make.** Stop and ask (`AskUserQuestion`, one question per decision, recommendation first) when it:
- spends money or changes shared cloud or GitHub state beyond what the plan names, or is hard to reverse;
- needs a fact only the user has (a login, a billing account, an email, an amount);
- contradicts a decision the user made, or reopens a decision issue (#5, #6, #7 and the like);
- changes the scope of a neighbouring issue, or the product, taste or priorities in a way the docs do not settle.

Escalation is by reversibility and documentation, not by how unsure you feel:
- **Settled by the docs or an earlier user decision:** rule, whatever the stakes.
- **Docs silent or conflicting, cheap to change in review** (a name, a layout, a test choice): rule, log it.
- **Docs silent or conflicting, costly to change later** (a data shape other steps build on, a public interface, a dependency choice): rule only if one option is clearly better; otherwise ask. Whichever way, put it at the top of the final report under "rulings most worth a look".
- **Hard to undo, or a criterion above:** ask.

## 1. Plan (sub-agent)

Launch one `general-purpose` agent (`Agent`) with this brief, filled in:

> Run the `dc-plan` skill for issue #N. Autonomous mode, overriding the skill's review steps: do not publish an artifact and do not wait for approval. Instead (a) do NOT post anything yet: draft the plan and its open questions, and return them; the orchestrator rules, then resumes you to post. Each open question gets the options, your recommendation, the reason (cite the LLD, HLD or issue that settles it), and a reversibility note (cheap to change in review, costly, or hard to undo). Do not ask the user anything; (b) when resumed with rulings, fold them in, rewrite the issue's "Done when" if the plan calls for it (keeping Work, Implements, Blocked by and the footer), and post the plan as an issue comment, exactly as the skill's step 6 describes. Do not start any implementation or branch work. Public-thread hygiene applies. First reply, nothing else: (1) the proposed acceptance rewrite, old and new, one line each; (2) the open questions as above; (3) top risks; (4) what the plan declares "Not proven here". Reply after posting: the comment URL and any change from the draft.

Keep the agent id. When it returns the draft, you rule on each open question (see Authority): normally accept its recommendation when the docs settle it, overrule when the docs or an earlier user decision say otherwise, and escalate per the criteria. Ask the user for the escalations only, then resume the same agent with `SendMessage` carrying every ruling and reason, and let it post. Keep the table of questions, rulings and reasons for the final report.

**Check the plan.** Read the posted comment (`gh issue view N --comments`). Confirm it has the TDD mapping, a verification matrix tied to the acceptance criteria, phases with gates and commit messages, a docs table, risks, and a "Not proven here" line, and that nothing private is in it. If a ruling looks wrong, message the agent to amend it and say why; do not rewrite the plan yourself.

## 2. Implement (sub-agent)

Launch a second `general-purpose` agent:

> Run the `dc-implement` skill for issue #N, following the posted plan comment; do not re-plan. Autonomous mode: rule on small deviations yourself, and record each (what differed, how you ruled, why) for the PR body and the LLD edits. Stop and report instead of continuing only when you are blocked on something that needs the user: an interactive login, a fact only they have, or an action the plan did not authorize that spends money or changes shared state. Do not run `/code-review` (the orchestrator does); open the PR once docs are done. Never merge. Final reply, nothing else: PR URL and branch; the red and green results (counts and the gate commands); mutation and idempotence results; deviations with rulings and reasons; "Not proven here" with the step that proves each; defaults chosen that the user might not expect; anything blocked.

Keep the agent id. If it reports a block, ask the user and resume it with `SendMessage`.

## 3. Verify (you, light)

Do not re-read what the agent read. Check the artifacts:
- `gh pr view N`, `gh pr checks` (note anything failing), `git diff --stat main...branch` (is the footprint what the plan expected; any file that should not be there?).
- Fetch the branch and run the commands the plan names as gates (for example `bun run lint`, `bun run typecheck`, the test command), output to a file and tail it. Compare with the counts in the report; a mismatch is a finding.
- Scan the diff and PR text for secrets and private identifiers (billing IDs, project numbers, personal emails, tokens).
- Check the docs the plan listed were touched, and that the "Not proven here" list does not claim anything a later step must prove.
Put any problem into the review message in step 4 rather than fixing it yourself.

## 4. Review (you, with a sub-agent doing the fixes)

Run the `code-review` skill at `high` on the branch (it runs in the background and returns findings). When it reports, rule on every finding:
- **Fix** every real finding, and every nit that is cheap and honest to fix.
- **Decline** only with a reason (out of scope, owned by a later issue, wrong).
Add your verification findings from step 3. Send the whole list to the implementation agent with `SendMessage`: each item, your ruling, and the reason. Ask it to fix, re-run its gates and the idempotence pass, push, and append a "Review" section to the PR body listing what was fixed and what was declined and why. Then repeat step 3 briefly. One round is normal; a second only for a real regression.

## 5. Report to the user

Short, in this order: the PR link and the checks result; **rulings I made** (plan questions, deviations, review findings: item, ruling, reason; keep it a table); **escalations** you asked about, or "none"; what the user might not expect (defaults, deviations, LLD edits); what is not proven and which step proves it. Say plainly anything unverified or failing. Offer the merge; do not merge.

## 6. Merge

Only when the user says to: `gh pr merge N --squash --delete-branch`, `git checkout main && git pull`, confirm the issue closed, say what is unblocked.

## Rules

- One step, one PR. The sub-agents stay inside the issue's scope and so do you.
- Never claim a seam is proven that only a later step can prove, and never relay a sub-agent's claim you have not checked against the artifact.
- Never paste long sub-agent output into this session; ask for the short report format above and re-ask if it comes back long.
- Sub-agents cannot ask the user anything. Anything that needs the user comes back to you as a block or escalation, and you ask.
