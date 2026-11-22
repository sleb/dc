# AGENTS.md

Working notes for any coding agent (Claude Code, Codex, Pi, Cursor, …) in this repo. `README.md` and `docs/` are the source of truth for what is built and why; when a decision changes, update those, not this file. Do not restate their content here.

## Where things are documented

- `README.md`: prerequisites, every gate command, the package layout table.
- `docs/lld/00-platform-build-deploy.md`: repo, build, lint and TypeScript policy, secret handling, CI/CD, deploy order. Read sections 3 and 5 before adding files or dependencies.
- `docs/lld/01`–`07`: engine, view projector, game store, identity, command contracts, notifications, web client. The LLD a change belongs to owns its detail.
- `docs/high-level-design.md` and `docs/gameplay.md`: component contracts and game rules; `gameplay.md` is the source of truth for rules.
- GitHub issues: one "step" issue per PR, labelled with its milestone, plus `decision` issues. The tracking issue for the execution plan is #54.

## Skills

The skills live in `.agents/skills/` (the Agent Skills layout; `.claude/skills/` holds symlinks to them for Claude Code). `scripts/skills.test.ts` fails if a skill, its frontmatter, its symlink and the table below disagree:

| Skill | Use it to |
|---|---|
| `dc-plan` | turn a step issue into a reviewed execution plan; posts the plan to the issue when approved |
| `dc-implement` | execute an approved plan on the issue: red, green, docs, review, PR |
| `dc-ship` | run plan and implement as sub-agents from a small orchestrating session, for one issue |
| `dc-ship-milestone` | ship a slice of a milestone unattended: one batch branch, one PR, one human review at the end |

## Conventions

- **Strict TDD.** No production change without a failing test or check first. Code steps: a failing `bun test` / emulator / rules / Playwright test. Infra and setup steps: a read-only verification script that fails for a stated reason against the empty state. Include a "test the test" pass; for scripts, re-run and prove idempotence.
- **One step, one PR.** Branch `step/N.M-short-name` off `main`; never commit to `main`. Leave neighbouring steps and other environments alone, and say so in the PR. A batch run (`dc-ship-milestone`) is the exception: one `batch/M<n>-<slug>` branch and one PR, one commit range per step, the PR's `Closes` list firing when the slice merges, and the human's review at the end.
- **Keep the docs current in the same PR.** If reality differs from an LLD, amend the LLD, note the deviation in the PR body, and mark resolved open questions with the issue that proved them. State plainly what is not proven and which later step proves it.
- **Never claim a seam is proven** that only a later step can prove.
- **Public thread hygiene.** Issues, PRs, commits and docs are public: no personal emails, billing account IDs, project numbers, tokens or secret values. Use placeholders such as `<BILLING_ACCOUNT_ID>`; scripts take real values as flags or env vars at run time. Generate secrets and pipe them; never echo them, pass them as arguments, or write them to disk. `bun scripts/scan-secrets.ts` is the scan.
- **Bun, not npm**, except the Functions bundle (`build:functions` runs `npm install` in `functions/dist` for the runtime). Dependencies stay exact-pinned (`bunfig.toml` sets `exact = true`) and `bun.lock` is committed.
- **No attribution lines** in commits or PRs.
- **Ask only for what is the user's to decide** (a billing account, an email, an amount, a merge). Pick a sensible default for everything else and say so in the PR. Actions that spend money, change shared cloud or GitHub state, or are hard to reverse need explicit authorization first.
