# Remote access in Settings: failure cases (written before the port, 2026-11-04)

The classic inbox held the only UI for remote devices: Settings → Remote access with Pair a device (QR and one-time link, on this
machine only), device rename and revoke, and inside the remote app a host label and a Hosts link back to the switcher. There is no CLI
for pairing, rename or revoke, and the Host agent may not pair (`remote-pair-start` is excluded from its tools), so retiring the classic
inbox without a port would leave no way to pair a phone or cut off a lost one. The new client shows only the relay state.

`scripts/remote-settings-e2e.mjs` runs an isolated host against a local fake relay (TLS on 127.0.0.1 with a throwaway certificate the
host trusts through `NODE_EXTRA_CA_CERTS`; it speaks only the challenge/ready handshake and records device lists). Never a real relay.

- R1 Remote off: the section says how to turn it on and offers no Pair button.
- R2 Remote turned on (`remote-reload`) while Settings is open: the relay state reaches the page through a host topic, with no polling
  and no page reload.
- R3 Paired devices are listed by name, with last seen; revoked devices are not listed; a device name is text, never markup.
- R4 Pair a device shows the QR (only a plain SVG is rendered) and the one-time link with its expiry; Cancel ends the pairing on the
  host and removes the QR.
- R5 Rename edits in place; Enter saves to the host, Esc cancels; an empty name is refused in place.
- R6 Revoke asks for a second press; the first press changes nothing on the host; the second revokes and the device leaves the list.
- R7 A change made elsewhere (a rename over RPC, a pairing that expires) reaches the open section through the host topic, without
  polling: the page reads remote state only when told to.
- R8 Inside the remote app (a page the relay bootstrap labels with its host), pairing, rename and revoke are not offered (the host
  refuses them from a remote device anyway) and the top bar shows the host name with a Hosts link back to the host list.
- R9 Relay down: the state says so, and Pair a device shows the host's refusal in place instead of failing silently.
- R10 The section stays usable at 390px.

Red before the port: `artifacts/only-inbox/red-remote-settings.json` (no `#remote-access` in the section). Green after it, all of
R1-R10: `artifacts/only-inbox/green-remote-settings.json`. The host now publishes topic `remote` (`createRemote({ changed })`) on
relay state, error, pairing and registry changes, and `remote-status` carries `pairing: { expiresAt } | null` (never the code).
