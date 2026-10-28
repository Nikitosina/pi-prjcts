# Workers conversation tree failure cases

Record before implementing the regression journey:

- Multiple work items for one thread produce duplicate conversation nodes or wrong navigation/control targets.
- Queued follow-ups appear out of order, as running, or with invented per-work context usage.
- Terminal or blocked work disappears, loses its reason, or archived work returns.
- A verifier or delegated child is detached from its real parent, missing, duplicated, or creates an infinite cycle; orphaned references disappear.
- Disclosure state, selection, or keyboard focus is lost on a routine snapshot refresh.
- Idle, empty and multiple-conversation states misrepresent activity.
- Light, dark or narrow layout obscures controls, and disclosure state is not accessible.
- The browser tree disagrees with read-only persisted host state, or reports a failed/stopped verifier as passed.
- Work priority changes dispatch order but the panel presents follow-ups in a misleading order.
