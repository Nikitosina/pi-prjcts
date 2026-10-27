# Quota fallback settings

Choose an opt-in worker fallback through project settings, review and save it, then confirm persistence without changing the primary model.

## Sub-features

- Worker fallback picker, save review, reload persistence and read-only host proof.

## How to get to it (user POV)

- Open project settings with `#settings-button`, then find Quota recovery.

## Driving it with browser CDP

Scripted with `verify.mjs drive --run <scratch> quota-settings`. The private launch provides two fake models. The journey clicks the worker fallback picker, types a model name with `Input.insertText`, selects it, reviews and confirms the change, then reloads. Screenshots record before, typed, review and saved states. Read-only `show` verifies the stored fallback and unchanged primary model; `plan-snapshot` verifies no work was admitted.

## Gotchas

- Run doctor first. Only the isolated launch host is allowed.
- This proves settings persistence, not provider failover. The quota recovery regression uses a separate local fake provider for that.
