# Project simulator sections

The owner first selected layout A: a small, read-only simulator card above Workers beside the coordinator chat, with an expanded screenshot dialog. The card later moved to Settings → Plugins as a panel (`mount(slot, panel)`) with clone tabs, lifecycle buttons, a More actions menu and a screenshot.

Plugin browser code is now removed for every host (REMOTE_SPEC.md decision 16), so the panel, its stylesheet and the `/plugins/simulator/frame` route are gone. Core draws two declarative settings sections from `section.ts`:

- iOS simulators: management on or off with one button (turning it off asks inline), one row per owned clone with its name, state and lease holder, and an unknown outcome with its reason and a dangerous acknowledgement that calls `recover`.
- Simulator slimming: one row per simslim category, kept or slimmed, with one toggle that saves the whole list through `configure`. Agents have no tool for these categories, so this is the owner's only control.

Boot, shut down, create, reset and delete stay with the Coordinator and worker tools, as do screenshots and rotation. The page shows no screenshot.

Each button carries a request id derived from a per-start nonce, the project, a counter bumped after each `configure` or `recover`, and the button's target. An unchanged state therefore draws the same view on every poll, and a changed one never replays an old receipt.

Frontend proof uses a private host with fixture devices: `scripts/simulator-section-e2e.mjs` runs a fake simslim, never a real simulator. Backend ownership enforcement and real lifecycle checks are separate.
