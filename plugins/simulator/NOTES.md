# Project simulator card

The owner selected layout A: a small, read-only simulator card above Workers beside the coordinator chat, with an expanded screenshot dialog. Simulators stay optional. The separate tab and fleet-dock prototypes were rejected and removed.

The production card uses the existing authenticated project API and `/simulator-frame` bearer-authenticated image endpoint. It does not forward pointer, keyboard or gesture input. Screenshot requests run only for the selected project on the visible coordinator tab. Project changes abort captures and clear their blob URLs.

Enabling simulator management permits agents to manage only clones created and recorded for that project. The selected source is only cloned, not modified. Reset/delete controls require explicit owner confirmation in the browser; worker leases and uncertain operations block lifecycle controls. Disabling keeps the owned clone and its data. Deleting keeps the enablement grant so an agent can create a replacement later.

Frontend checks use a disposable mock API, not a production host or simulator. `artifacts/simulator-card-browser/report.json` records the walkthrough; screenshots cover the optional card, running card, expanded view, deletion and 390px layout. Backend ownership enforcement and real lifecycle checks are separate.
