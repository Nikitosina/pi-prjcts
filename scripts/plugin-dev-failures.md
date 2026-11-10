# Failure modes: developing a plugin (`projects plugin new|check`)

Written before the code. Test: `scripts/plugin-dev-unit.mjs` (temp directories only, no host, no model, no live home). Loading the scaffold on a private host and the browser panel are cases 27-29 of `scripts/vcs-plugins-failures.md`.

Scaffold (`plugin new <dir> --name <name>`)
1. `plugin new` writes into a directory that already has files, overwriting the author's work. It must refuse and write nothing.
2. A name the loader would refuse (not `/^[a-z][a-z0-9-]{0,39}$/`) is scaffolded anyway, so the first host start fails. It must be refused before anything is written.
3. The scaffold drifts from the plugin contract: its own test fails, or the real loader refuses it.
4. The scaffold needs credentials, the network or the core checkout: its test must run with plain `node --test` from any directory, deterministic.

Check (`plugin check <dir>`)
5. `plugin check` reads or writes the live home: it must use a fresh temporary home whatever `PI_PROJECTS_HOME` says, ignore that home's `plugins.json`, and remove the temporary home afterwards.
6. `plugin check` also loads plugins from an inherited `PI_PROJECTS_PLUGINS`: it must load only the given directory.
7. A broken plugin passes the check, or the check hides why: it must exit 1 and print the same status the host records (`state: "failed"`, `error`).
8. The check validates differently from the host (a second loader): the error text for a provider with a missing method must be the host loader's.
11. A close hook that never settles and holds no timer or socket lets the process exit at the end of the event loop, mid-`await`, with no JSON printed and the temporary home left behind. The check must still print its result and remove the home.

Version
9. A plugin without `version` stops loading: existing plugins must load unchanged, with `version: null`.
10. A `version` that is not a short non-empty string is accepted silently: the plugin must fail to load with a reason naming `version`.
