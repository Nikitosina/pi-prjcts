# Pause projects when the corporate VPN goes down

Load `plugins/network-gate` on hosts that use Tunnelblick. It is off by default. The watcher samples the configured VPN (`yteam fixed`) and HTTPS probe (`https://a.yandex-team.ru`) every 15 seconds. A good sample requires both CONNECTED and a successful probe. Two consecutive bad samples declare an outage; two consecutive good samples end it.

To override defaults, write `settings.json` under `$PI_PROJECTS_HOME/plugins/network-gate/` and restart the host. Fields: `configuration`, `probeUrl` (HTTPS), `intervalMs` (15000), `stuckMs` (60000). macOS must allow the host to control Tunnelblick and change Wi-Fi power.

The plugin uses the ordinary host project pause and resume operations. It records why it paused a project and keeps its list across host restarts. Projects already paused or not enabled for the plugin are skipped. Manual pause and resume take precedence. Recovery resumes only pauses still owned by the plugin. Settings → Plugins shows the watcher, last repair, failures and paused projects.

After 60 seconds stuck reconnecting, disconnect then connect. If stuck disconnecting, switch the Wi-Fi interface off, disconnect, restore Wi-Fi and connect. If disconnected with a working uplink, connect. Back off for 15, 30 and 60 seconds across three failed repairs, notify the owner once, then observe until recovery.

Pause aborts running turns and kills live agent processes, including builds. Resume sends workers the standard continue message. It does not continue an aborted coordinator turn. This is project control, not a provider dispatch gate. No changes to Durable or host routing.
