# Telegram artifact attachments

Coordinator results enter the persistent notification feed in `src/notify.ts`. The Telegram bridge used to pass the entire result through the HTML converter. That converter drops non-public link targets, leaving the image marker and caption as `!caption`. Telegram never received a file.

The bridge now extracts `![caption](artifact:<threadUUID>/<path>)` before HTML conversion, saves an ordered text/media plan in its existing outbox cursor, checks thread ownership using the project's existing `thread-history` dispatch, and reads bytes using `openArtifact`. No browser artifact URLs, remote URLs, or arbitrary host paths are fetched. Code examples remain text. Other image URLs produce an explicit unavailable-attachment message.

## Formats and limits

- PNG and JPEG use `sendPhoto` up to 10,000,000 bytes.
- MP4 uses `sendVideo` up to 50,000,000 bytes. Playback still depends on the codecs and Telegram clients.
- Other files, including WebM, GIF and WebP, use `sendDocument` up to 50,000,000 bytes. Photos over 10 MB also use documents.
- A rejected photo/video, including an unsupported codec or photo dimensions, falls back to a document only after an explicit Bot API 400 rejection. If Telegram also rejects the document, the bridge sends an honest failure message.
- Empty, missing, unauthorized, unsafe or oversized files produce a text explanation, never a private URL. Paths must pass the artifact store's traversal and symlink checks.
- Captions use plain text, at most 1024 UTF-16 code units. Longer caption text follows as ordinary chunks. Surrounding text keeps the existing HTML conversion and 4096-character splitting. Replies to uploaded media route back to the originating project chat.

These limits are conservative byte caps from the current public Bot API, not the optional local Bot API server limits. Source: https://core.telegram.org/bots/api#sendphoto, https://core.telegram.org/bots/api#sendvideo, https://core.telegram.org/bots/api#senddocument.

## Retry and restart

The saved plan keeps part numbering stable if files disappear during a retry. Successful parts are checkpointed before later parts. An explicit rejection such as 429 can retry without replaying earlier parts.

Telegram has no client idempotency key for media sends. The bridge saves a pending-media flag *before* upload. A network failure, server error, or crash before the successful response is checkpointed leaves the flag set. Automatic resend and later notices stop rather than risk a duplicate. Settings reports an uncertain-delivery error. An operator must inspect the actual linked Telegram conversation before resolving this cursor in `telegram.json`, with the host stopped under separate authorization. Do not clear the flag or retry blindly. This change does not add automatic recovery for that fundamentally ambiguous case. Existing text-only delivery and its retry behavior are unchanged.

## Verification

`node scripts/telegram-media-unit.mjs` runs the actual bridge against an isolated mocked multipart Bot API. It verifies file bytes/MIME, photo/video/document methods, captions, size/traversal/symlink/missing/unauthorized/URL rejection, text chunking, explicit-rejection retry ordering and uncertain-delivery blocking across restart. It uses fake credentials only. `npm run verify` includes this test.
