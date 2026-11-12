# Project simulator panel

The owner first selected layout A: a small, read-only simulator card above Workers beside the coordinator chat, with an expanded screenshot dialog. The separate tab and fleet-dock prototypes were rejected and removed. Simulators stay optional.

When the classic inbox retired its context-panel hooks, the card moved to Settings → Plugins as a panel (`mount(slot, panel)`). It keeps the card's controls: one tab per owned clone, boot and shut down, new clone from a shut-down source, reset, delete, turning management on and off, inspect and acknowledge, retry of an unconfirmed request, and an enlarged screenshot. The panel API has no dialogs or toasts, so confirmations open inline in the panel and results show as a line under the controls.

The panel uses the plugin's RPC methods and the bearer-authenticated `/plugins/simulator/frame` route through `panel.rpc` and `panel.fetch`. It does not forward pointer, keyboard or gesture input. Polling and captures run only while the panel is mounted and the page is visible; the mount's signal stops them and its object URLs are revoked. A request whose answer never arrived stays per project in page memory, so Retry exact request resends the same request id after Settings is reopened.

Frontend proof uses a private host with fixture devices: `scripts/simulator-panel-e2e.mjs` runs a fake simslim and a fake XcodeBuildMCP, never a real simulator. Backend ownership enforcement and real lifecycle checks are separate.
