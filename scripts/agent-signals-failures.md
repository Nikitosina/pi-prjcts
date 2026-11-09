# Agent signals: ways they can fail

Written before the code. Owner decisions from the retro grilling (2026-11-09): a background wait may last up to 30 minutes but returns
as soon as a message is queued for the waiting agent; source edits through bash and glued-together words in briefs get a
model-visible warning while the command or message still goes through. Proof: `scripts/agent-signals-e2e.mjs` (Q, S, G) and
`scripts/jobs-e2e.mjs` (W, G6).

## Queued input during a wait (`src/queued-input.ts`, `projects_bg_status`, `agents wait`)
- Q1 `waitSeconds` above 120 is refused, so an agent polls a long build every two minutes.
- Q2 A steer for the waiting agent sits in its inbox until the wait times out (up to 30 minutes), so the owner's or Coordinator's
  message is delayed.
- Q3 A follow-up queued during the wait does not end it either.
- Q4 A follow-up that was already queued when the wait began ends every later wait at once, so the agent cannot wait at all.
- Q5 The early return reports the command as ended, or drops its tail, instead of `running` with a note that a message arrived.
- Q6 The watcher keeps polling after the call returned or was aborted (a leaked timer per call).
- Q7 A conversation whose inbox document was never created makes the watcher throw instead of waiting.
- Q8 The Coordinator's `agents wait` keeps an owner message waiting for up to 15 minutes.

## Stall detector (`stallTick` in `src/jobs.ts`)
- W1 A worker inside a long `projects_bg_status` wait on a background command that keeps printing is reported stalled after
  `stallMinutes`.
- W2 A worker inside such a wait on a background command that printed nothing for `stallMinutes` is no longer reported.

## Source writes through bash (`src/source-writes.ts`, bash wrapper, `projects_bg_start`)
- S1 `sed -i` is missed in one of its forms: `-i`, `-i ''`, `-i.bak`, `-Ei`, `-ni`, `--in-place`, `--in-place=.bak`, `-e` before
  `-i`, behind `find -exec` or `xargs`, inside `bash -c`, or after `&&`/`;`/`|`.
- S2 `perl -pi`, `perl -i -pe`, `perl -pi.bak -e` or `perl -0pi` is missed; `perl -MList::Util` or `perl -ne` is flagged.
- S3 A python/python3/node heredoc or `-c`/`-e` script that writes files (`open(..., 'w'|'a'|'r+')`, `write_text`, `write_bytes`,
  `writeFileSync`, `appendFileSync`, `fs.promises.writeFile`) is missed.
- S4 Read-only analysis is flagged: `open(path)`, `open(path, 'r')`, `read_text()`, `readFileSync`, `json.load`, `print`.
- S5 A write whose every target is clearly scratch (`/tmp`, `/private/tmp`, `$TMPDIR`, `$PI_WORKSPACE_CACHE`) is flagged.
- S6 A write with one scratch target and one source target, or a target only known at run time (a variable, `{}`, xargs input), is not
  flagged.
- S7 `sed` or `perl` as an argument (`grep -r sed`, `echo perl -pi`) or inside quotes of another command's text is flagged.
- S8 The warning changes what runs or what the command prints, or makes the call an error.
- S9 The warning is not visible to the model (it is only in details), or does not say to use the edit tool and that `str.replace`
  silently does nothing when the text is absent.
- S10 `projects_bg_start` runs the command without the same warning.
- S11 A malformed command (unbalanced quotes, unterminated heredoc) throws in the detector and fails the bash call.

## Glued words (`src/glued-words.ts`, `agents spawn`/`send`, `subagent`)
- G1 A long glued token is missed: Latin (`Couldmerelykeepownedsessionrunningwhilelocaldebugandrenewlease`) or Cyrillic
  (`атомарнопосуществующемуledger,далееперераспределениерезервов`), counted in UTF-16 units instead of characters.
- G2 A long token that is legitimately unspaced is flagged: a 40- or 64-character hex hash, a UUID, a path, a URL, an identifier with
  `_`, `.`, `:` or `=`, or anything inside fenced or inline code.
- G3 Trailing punctuation hides a hash (`<sha>.` or `<sha>),`) and flags it.
- G4 The message is refused or altered instead of delivered.
- G5 The warning lists every suspect or full tokens; it must list at most 5, each cut to about 60 characters, and ask for normal
  spacing next time.
- G6 A brief (spawn), a steer (send) or a subagent task carries glued words and the sender's tool result has no warning; a clean
  message gets one.
