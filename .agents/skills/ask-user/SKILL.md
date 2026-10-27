---
name: ask-user
description: "Use before consequential architecture, security or product choices, costly-to-reverse changes, new authority, or materially missing requirements. Not for routine reversible choices or merely having several options. Gather evidence, present the decision and collect explicit owner choice before proceeding."
---

# Ask-user decision gate

## Gate

Ask when available evidence leaves a consequential choice open:

- A preference-dependent choice changes product outcomes, architecture, security posture or public contracts.
- A change is costly to undo, destructive or irreversible, or requires authority not yet granted.
- Requirements or constraints are materially missing or conflicting, and the wrong assumption would change the outcome.

Routine reversible choices are yours, including naming, formatting, file placement and equivalent internal structures. Several valid options alone do not open the gate. Choose a reversible option and continue. An explicit owner decision for this exact trade-off closes the gate; reuse it across iterations. Explicit owner conversation requirements count as a spec. Ask only for material missing parts.

## Agent Protocol Handshake (required)

1. **Classify the boundary.** Consequential choice, missing authority, material ambiguity, or routine reversible work. Continue routine work without a question.
2. **Gather evidence.** Read available source and documents before asking. State what remains unknown and why evidence cannot settle it.
3. **Summarize.** Give the current state, constraints, trade-offs and a recommendation if justified.
4. **Ask one focused decision.** Use `ask_user` when offered, otherwise the host's authorized project question tool with the same context and choices. Read its actual schema rather than assuming fields. Give a small set of outcome-oriented options and allow freeform when appropriate. Batch only independent decisions whose prerequisites are settled. If no decision tool is available, state the exact decision needed and wait for the owner. Never invent a tool or grant.
5. **Record the answer.** Restate the chosen outcome, preserve it for later repair iterations and proceed only within existing authorization. A decision answer grants no new execution, publication, merge or deployment permission unless it explicitly supplies that authority through the required host process.
6. **Reopen only on new evidence.** Explain the materially changed fact before asking again.

## Anti-overasking guardrails (required)

One question per decision boundary normally. If the answer is unclear or cancelled, ask at most one narrower follow-up with a recommendation, a different choice and a stop option. Never ask the same trade-off again without new evidence.

After that follow-up, a consequential or unauthorized action stays blocked until the owner decides. For ambiguity alone, proceed with the most reversible option only when the owner explicitly delegates the choice. State the assumption. A cancellation is not approval.

Do not ask questions that source inspection can answer, request permission for routine gap repair already authorized, or use a batch to hide dependent choices. Report a genuine blocked decision with the evidence, the attempted clarification and what the owner must decide.
