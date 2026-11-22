---
name: dc-ship
description: Take a Deep Cuts step issue from plan to open PR with minimal main-session context. Runs the dc-plan and dc-implement skills as sub-agents, rules on open questions itself, runs a code review itself and rules on the findings, verifies the result, and reports. Stops for the user only on genuinely user-owned decisions, and merges only when told. Use when asked to "ship", or do plan and implement for, GH issue #N.
compatibility: Needs sub-agent delegation, git, and an authenticated `gh` CLI for the target repo.
---

# dc-ship: plan, implement and review one Deep Cuts step issue

This skill takes one argument, a GitHub issue number; it is called `N` below (read it from the invocation arguments, `$ARGUMENTS` in agents that expose it).

Ship `#N`. You are the orchestrator. The point is to keep this session small: the heavy reading, writing and debugging happens in sub-agents, and you see their reports and check their artifacts. The GitHub issue is the handoff between phases (plan comment in, PR out), so no context needs to be passed along.

Read `../dc-plan/SKILL.md` and `../dc-implement/SKILL.md` once so you can brief the sub-agents and judge their output.

## Authority

The user's invocation of this skill authorizes everything the dc-plan and dc-implement skills would do for this issue, including rewriting the issue's "Done when", posting the plan comment, pushing the branch and opening the PR. It does not authorize merging.

**Rule it yourself, report it later.** Open questions, acceptance rewrites, deviations from an LLD, review findings: decide them using the LLD, the HLD, the tracking issue and the user's earlier decisions, pick the option you would recommend, and record the question, the ruling and the reason. The user reads these in the final report and can overturn any.

**Escalate only when a ruling is not yours to make.** Stop and ask (one question per decision, nothing bundled, your recommendation first) when it:
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

Launch one general-purpose sub-agent with this brief, filled in:

> Run the `dc-plan` skill for issue #N. Autonomous mode, overriding the skill's review steps: do not publish an artifact and do not wait for approval. Instead (a) do NOT post anything yet: draft the plan and its open questions, and return them; the orchestrator rules, then resumes you to post. Each open question gets the options, your recommendation, the reason (cite the LLD, HLD or issue that settles it), and a reversibility note (cheap to change in review, costly, or hard to undo). Do not ask the user anything; (b) when resumed with rulings, fold them in, rewrite the issue's "Done when" if the plan calls for it (keeping Work, Implements, Blocked by and the footer), and post the plan as an issue comment, exactly as the skill's step 6 describes. Do not start any implementation or branch work. Public-thread hygiene applies. First reply, nothing else: (1) the proposed acceptance rewrite, old and new, one line each; (2) the open questions as above; (3) top risks; (4) what the plan declares "Not proven here". Reply after posting: the comment URL and any change from the draft.

Keep a handle to the agent (its id) so you can resume it. When it returns the draft, you rule on each open question (see Authority): normally accept its recommendation when the docs settle it, overrule when the docs or an earlier user decision say otherwise, and escalate per the criteria. Ask the user for the escalations only, then send the same agent a follow-up message carrying every ruling and reason, and let it post. Keep the table of questions, rulings and reasons for the final report.

**Check the plan.** Read the posted comment (`gh issue view N --comments`). Confirm it has the TDD mapping, a verification matrix tied to the acceptance criteria, phases with gates and commit messages, a docs table, risks, and a "Not proven here" line, and that nothing private is in it. If a ruling looks wrong, message the agent to amend it and say why; do not rewrite the plan yourself.

## 2. Implement (sub-agent)

Launch a second `general-purpose` agent:

> Run the `dc-implement` skill for issue #N, following the posted plan comment; do not re-plan. Autonomous mode: rule on small deviations yourself, and record each (what differed, how you ruled, why) for the PR body and the LLD edits. Stop and report instead of continuing only when you are blocked on something that needs the user: an interactive login, a fact only they have, or an action the plan did not authorize that spends money or changes shared state. Do not run the `code-review` skill (the orchestrator does, and posts its findings as PR comments); open the PR once docs are done. Never merge. Final reply, nothing else: PR URL and branch; the red and green results (counts and the gate commands); mutation and idempotence results; deviations with rulings and reasons; "Not proven here" with the step that proves each; defaults chosen that the user might not expect; anything blocked.

Keep the agent id. If it reports a block, ask the user and resume it with a follow-up message.

## 3. Verify (you, light)

Do not re-read what the agent read. Check the artifacts:
- `gh pr view N`, `gh pr checks` (note anything failing), `git diff --stat main...branch` (is the footprint what the plan expected; any file that should not be there?).
- Fetch the branch and run the commands the plan names as gates (for example `bun run lint`, `bun run typecheck`, the test command), output to a file and tail it. Compare with the counts in the report; a mismatch is a finding.
- Scan the diff and PR text for secrets and private identifiers (billing IDs, project numbers, personal emails, tokens).
- Check the docs the plan listed were touched, and that the "Not proven here" list does not claim anything a later step must prove.
Put any problem into the review message in step 4 rather than fixing it yourself.

## 4. Review (you, with a sub-agent doing the fixes)

The review lives on the PR, so the record of what changed and why stays with the code and the handoff stays short.

**Post.** Run the `code-review` skill at high effort with `--comment` on the PR, or your agent's review tooling if it has none (a background review that posts its findings as inline PR comments). Then list them: `gh api repos/{owner}/{repo}/pulls/N/comments` for the comment ids and `gh api graphql` (`reviewThreads { id isResolved comments(first:1) { nodes { databaseId body path } } }`) for the thread ids. If a finding could not be anchored to a diff line and was not posted inline, post it yourself as a PR comment so every finding has a thread. Add your step 3 verification findings the same way (inline where they have a line, otherwise a PR comment).

**Rule on every thread.** Reply on the thread with the ruling and the reason:
- **Fix** every real finding, and every nit that is cheap and honest to fix. Reply `Fix: <one-line reason or the shape of the fix if not obvious>`. Leave it open.
- **Won't fix** only with a reason (out of scope, owned by a later issue, wrong). Reply `Won't fix: <reason>` and resolve the thread yourself, since nothing further will happen on it.

**Hand off.** Send the implementation agent a short follow-up message: the PR number, the ids (or "every open thread marked `Fix:`") to fix, and nothing else. It reads each thread for the location and context. Ask it to, for each thread it was told to fix:
1. fix it (test first where practical);
2. reply on the thread with the commit SHA and what changed (`Fixed in <sha>: ...`), or, if it disagrees or deviates, say so and why. It does not resolve; you do;
3. re-run its gates and the idempotence pass, push, and add a short "Review" section to the PR body that links to the threads (fixed, won't fix and why).

**Close the threads.** After it reports, run step 3 briefly, then read each reply and the commit it cites. If satisfied, resolve the thread (`gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=<threadId>`). If not, reply with what is still wrong and leave it open, and send the agent the thread ids to rework. One round is normal; a second only for a real regression. Finish only when every thread is resolved or deliberately left open and named in the report.

## 5. Report to the user

Short, in this order: the PR link and the checks result; **rulings I made** (plan questions, deviations, review findings: item, ruling, reason; keep it a table); **escalations** you asked about, or "none"; what the user might not expect (defaults, deviations, LLD edits); review threads (fixed, won't fix, open); what is not proven and which step proves it. Say plainly anything unverified or failing. Offer the merge; do not merge.

## 6. Merge

Only when the user says to: `gh pr merge N --squash --delete-branch`, `git checkout main && git pull`, confirm the issue closed, say what is unblocked.

## Rules

- One step, one PR. The sub-agents stay inside the issue's scope and so do you.
- Never claim a seam is proven that only a later step can prove, and never relay a sub-agent's claim you have not checked against the artifact.
- Never paste long sub-agent output into this session; ask for the short report format above and re-ask if it comes back long.
- Sub-agents cannot ask the user anything. Anything that needs the user comes back to you as a block or escalation, and you ask.
