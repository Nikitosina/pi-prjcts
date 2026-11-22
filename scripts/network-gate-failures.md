# Network gate checks

Use a temporary home, fake command runner for osascript and networksetup, and fake probe. Never use the owner's VPN, Wi-Fi or projects.

- A single failure or success must not toggle project state. Either a bad VPN state or a bad probe makes the sample bad. Prevent overlapping samples.
- On confirmed outage skip disabled and already-paused projects. Record a reason for every project actually paused. Reopening the host during an outage must preserve ownership. On confirmed recovery resume only projects still carrying this plugin's pause. Manual pause (including after a rapid resume) or owner resume wins. Do not re-pause an overridden project during that outage.
- For stuck RECONNECTING and DISCONNECTING check the full repair command order, threshold, power restoration on failure and device discovery. Only connect a disconnected configuration with a working uplink. Back off, limit attempts, notify once and keep sampling. Recovery resets the budget.
- Check the private Settings panel with fake status and paused projects. Never load the live watcher in UI verification.
