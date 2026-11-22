# Authority and escalation

`dc-ship` and `dc-ship-milestone` both read this. The user's invocation of either authorizes everything the `dc-plan` and `dc-implement` skills would do for the issues it names: rewriting an issue's "Done when", posting the plan comment, pushing the branch, opening the PR. It does not authorize merging.

## Rule it yourself, report it later

Open questions, acceptance rewrites, deviations from an LLD, review findings: decide them using the LLD, the HLD, the tracking issue and the user's earlier decisions, pick the option you would recommend, and record the question, the ruling and the reason. The user reads these in the final report and can overturn any.

## Escalate only when a ruling is not yours to make

Stop and ask (one question per decision, nothing bundled, your recommendation first) when it:

- spends money or changes shared cloud or GitHub state beyond what the plan names, or is hard to reverse;
- needs a fact only the user has (a login, a billing account, an email, an amount);
- contradicts a decision the user made, or reopens a decision issue (#5, #6, #7 and the like);
- changes the scope of a neighbouring issue, or the product, taste or priorities in a way the docs do not settle.

Escalation is by reversibility and documentation, not by how unsure you feel:

- **Settled by the docs or an earlier user decision:** rule, whatever the stakes.
- **Docs silent or conflicting, cheap to change in review** (a name, a layout, a test choice): rule, log it.
- **Docs silent or conflicting, costly to change later** (a data shape other steps build on, a public interface, a dependency choice): rule only if one option is clearly better; otherwise ask. Whichever way, put it at the top of the final report under "rulings most worth a look".
- **Hard to undo, or a criterion above:** ask.

## Never

- Take the money or shared-state action to unblock yourself, or settle a decision issue on the user's behalf.
- Invent a fact you are missing, or record a guess as a sourced answer.
- Relay a sub-agent's claim you have not checked against the artifact.
- Claim a seam is proven that only a later step can prove.
- Merge without being told.
