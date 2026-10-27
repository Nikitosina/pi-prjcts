---
name: code-review
description: "Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes: Standards (does the code follow this repo's documented coding standards?) and Spec (does the code match what the originating issue/spec asked for?). Runs both reviews in independent reviewers and reports them side by side. Use when the user wants to review a branch, work-in-progress changes, or asks to \"review since X\"."
---

Two-axis review of the diff between `HEAD` and a fixed point the user supplies:

- **Standards**: does the code conform to this repo's documented coding standards?
- **Spec**: does the code faithfully implement the originating issue / spec?

Each axis runs in its own fresh reviewer context so they don't pollute each other, then this skill aggregates the reports. Reviewers are static: they read the snapshot and report, never edit, build, or run anything.

For a PR, read the repo-local `pr-review` skill by name through the skill reader, [`../pr-review/SKILL.md`](../pr-review/SKILL.md), which pins the PR base/head and adds a Bugs/performance axis. It reuses steps 2, 3 and the briefs below.

## Process

### 1. Pin the fixed point

Whatever the user said is the fixed point (a commit SHA, branch name, tag, `main`, `HEAD~5`, etc.). Use the fixed point already supplied in the task or conversation. If none is supplied, ask for it. If the spec is also missing, ask for both inputs in one clarification.

Resolve it to immutable revisions and record them: fixed point and `HEAD` as full commit IDs.

| | Git | Arcadia (`.arc/` present; follow `/skill:arc`) |
|---|---|---|
| Resolve | `git rev-parse <fixed-point> HEAD` | Resolve full hashes with the installed arc skill using bounded `arc log -n <count>` and `arc info --json`; do not assume Git-only flags |
| Diff | `git diff <fixed-point-id>...<head-id>` | `arc diff <fixed-point-id> <head-id>` |
| Commits | `git log <fixed-point-id>..<head-id> --oneline` | `arc log -n <count> <fixed-point-id>..<head-id> --oneline`, page until the full range is captured |
| File at revision | `git show <head-id>:<path>` | `arc show <head-id>:<path>` |

Save the diff, the commit list, and every non-deleted changed file at the head revision into a fresh snapshot directory (`/tmp/code-review/<head-id>-<timestamp>/`). Collect the spec and standards in steps 2 and 3 before making it read-only. Put handoffs and reports in a separate writable round directory; immutable source paths stay unchanged. Reviewers read this snapshot; its paths stay unchanged for the whole round, even if the working tree moves.

A bad ref or an empty or truncated diff fails here, not inside the reviewers.

### 2. Identify the spec source

Use the spec the user supplied as inline requirements, a file path, or a URL, including explicit requirements stated earlier in the owner conversation. Reuse those requirements across repair iterations. Read the supplied source and save its full contents and source description in the snapshot before launching reviewers.

If the user did not provide a spec, ask them to provide one or explicitly choose a standards-only review. Do not infer the spec from commit messages, branch names, nearby documents, or the implementation being reviewed.

If a supplied source cannot be read, ask for accessible contents or a replacement. Do not silently skip the Spec axis because retrieval failed.

Proceed once the spec is available or the user explicitly confirms there is no spec or chooses standards-only. In the latter case, skip the **Spec** reviewer and report "no spec available".

### 3. Identify the standards sources

Read the repo's `CODING_STANDARDS.md` when present, applicable `AGENTS.md` files, and any other documented coding rules such as `CONTRIBUTING.md`. Follow their pointers to standards that apply to the changed files. Save their contents and revisions in the snapshot, then make it read-only before delegation.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below: a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation. Like any standard here, skip anything tooling already enforces.

Each smell reads *what it is* → *how to fix*; match it against the diff:

- **Mysterious Name**: a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code**: the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy**: a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps**: the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession**: a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches**: the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery**: one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change**: one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality**: abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains**: long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man**: a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest**: a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 4. Launch the reviewers

Delegate with the host's reviewer-role tools; the protocol is tool-neutral:

1. Write one handoff file per axis in the round directory. Each handoff is self-contained; do not assume inherited skills, `AGENTS.md`, or conversation.
2. Admit every axis, each in its own fresh context with its own task identity, before awaiting any. Queued admission under normal caps is fine; await only once all axes are admitted.
3. Await each reviewer, then page through its result until the host reports it complete. A truncated or partial page is not a report.
4. Save each complete answer separately in the round directory.

If admission or a reviewer fails, stop with the error and saved evidence; ask before changing model or protocol.

The caller prepares artifacts through its authorized tools or delegates preparation to a worker. Bind reviewer code tools to the pinned revision through the host's supported read target; a live parent tree is not an immutable snapshot. Inline inputs outside the reviewer's readable root rather than inventing file access.

Every handoff carries: the pinned revisions, snapshot paths, the diff command, the commit list, the instruction to read only (no edits, builds, or execution), and the rule that evidence it cannot read is reported as `evidence unavailable`, separately from findings, never as a violation.

**Standards handoff** adds the standards-source contents from step 3 and the smell baseline pasted in full (the reviewer has no other access to it), with this brief: "Report, per file/hunk where relevant, (a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls: documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words."

**Spec handoff** adds the full spec contents and its source, with this brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words."

Skip the Spec reviewer only after the user's explicit no-spec or standards-only choice in step 2. Mark the Spec axis as skipped, not passed, in the final report.

### 5. Aggregate

Present the two reports under `## Standards` and `## Spec` headings, verbatim or lightly cleaned. Keep the axes separate: no merging, no reranking.

End with a one-line summary: total findings per axis, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes.

## Why two axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.
