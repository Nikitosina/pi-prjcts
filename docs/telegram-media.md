# Telegram artifact attachments

Coordinator results enter the persistent notification feed in `src/notify.ts`. Previously the Telegram HTML converter dropped private artifact link targets and left `!caption`, without uploading a file. The bridge now extracts `![caption](artifact:<threadUUID>/<path>)`, authorizes the project's thread through existing `thread-history` dispatch, and reads actual bytes through `openArtifact`. It never fetches private artifact URLs, arbitrary URLs, or arbitrary host paths. Code examples remain text.

## Message layout and counts

A short illustrated coordinator reply is **one media message**, not a header message followed by attachment replies. Its formatted HTML caption contains the usual project/chat identity, notice label, complete response, artifact label and reply guidance. Buttons and origin reply routing are on that same photo, video or document. Photo/video captions request display above the media. No separate header/footer message is emitted.

If the normal wrapper would cause overflow, the bridge first shortens only reply guidance, for example to "Reply to chat." It never cuts response text to make room for boilerplate. Artifact labels appear in their original text positions, and files retain reference order.

- One attachment with fitting text: one `sendPhoto`, `sendVideo` or `sendDocument` call, one message.
- Two through ten compatible photos/videos without buttons: one `sendMediaGroup` call, one visually grouped album with a shared formatted caption on its first item. Telegram returns a separate message ID for each item; every ID is mapped to the originating coordinator chat. No separate wrapper messages.
- Album caption placement must be uniform on **every** item, even when only the first has caption text. Telegram's TDLib rejects mixed `show_caption_above_media` values with `Parameter show_caption_above_media must be the same for all messages`. Native albums set it true on every item; document fallback albums omit it everywhere. The caption and HTML parse mode still occur only once.
- More than ten compatible items: albums of up to ten, with a final single media message if one remains. Identity, response and footer occur only once, in the first caption.
- Albums have no `reply_markup` parameter. Notices with actions use individual media messages, putting actions on the last part instead of losing them or inventing an extra action-only wrapper. Unsupported/document formats also use individual messages. The first caption contains the shared response; later captions are empty rather than repeating it.
- Album byte buffering is capped at 50,000,000 bytes total. Larger collections use individual uploads. This is our memory bound, not a Telegram album limit.
- Long text: the first media/album caption carries the first caption-sized part; only remaining text spills into messages of up to 4096 parsed characters. There is no repeated header/footer or truncation. For a 6500-character response, this normally means one media message plus two text messages, rather than wrapping every attachment in separate messages. Spillover and ungrouped later media reply to the first media item for context.

Telegram documents captions as **0–1024 characters after entity parsing**, including HTML-formatted captions. Tags and escaped entity spelling do not consume the text budget. Splitting closes/reopens tags and never cuts an entity or Unicode character. The budget counts Unicode code points, not UTF-16 entity offsets. Multipart CRLF is normalized to LF as Telegram does. The text-only converter/splitter remains unchanged. The notifier preserves complete artifact-bearing coordinator results rather than applying its existing 3500-character text-only preview cap.

## Formats, failures and security

PNG/JPEG use `sendPhoto` through 10,000,000 bytes. MP4 uses `sendVideo` through 50,000,000 bytes; playback still depends on codecs and clients. Other files, including WebM/GIF/WebP, and photos over 10 MB use `sendDocument` through 50,000,000 bytes. Telegram also restricts photo dimensions to a width-plus-height of at most 10000 and an aspect ratio of at most 20.

An explicit native-media 400 rejection can fall back to a document, or an all-document album for a rejected photo/video album. Missing, unauthorized, empty, oversized or unsafe artifacts produce an honest failure message, never a URL. Symlinks/traversal are refused by the existing artifact store. Surrounding response text is retained even on failure. No album is selected unless all refs pass authorized metadata checks; files are checked again before upload. If a saved album loses a member before an upload or explicit-rejection retry, its plan is safely expanded into individual parts before any request. Valid files still send in order, and only unavailable items get failure explanations.

Sources checked against the current public Bot API:
- https://core.telegram.org/bots/api#sendphoto
- https://core.telegram.org/bots/api#sendvideo
- https://core.telegram.org/bots/api#senddocument
- https://core.telegram.org/bots/api#sendmediagroup

Telegram's TDLib `process_input_caption` checks `utf8_length` against the caption limit, and `fix_formatted_text` removes carriage returns: https://github.com/tdlib/td/blob/bc9c263e2bfee06aaab41e82db51a103376030bc/td/telegram/MessageContent.cpp and https://github.com/tdlib/td/blob/bc9c263e2bfee06aaab41e82db51a103376030bc/td/telegram/MessageEntity.cpp. The album placement constraint is in `check_message_group_message_contents` in the same MessageContent.cpp source.

The [HTTP 400 investigation](telegram-media-investigation.md) includes pinned source links, compiled original/corrected payload validation, the exact expected API error wording and remaining proof limits.

## Retry and restart

The existing outbox cursor saves the selected plan, successful part count, and first message ID for spillover linkage. An album checkpoints every returned message ID together. An explicit 429 rejection can retry without duplicating successful parts or headers.

Telegram has no client idempotency key for uploads. A pending-media flag is saved before each media or album request. A network/server failure, incomplete success response or crash before the success checkpoint blocks automatic resend and later notices, rather than risk duplicate media. Settings reports uncertain delivery.

A trusted transport guard that blocks a request **before forwarding it** uses `TelegramRequestNotSentError`, not a generic network exception. That clears the current pending flag and stops automatic retry; it must never be used for a timeout or a request that may have reached Telegram. An explicit API 400 is a confirmed rejection. A locally blocked fallback after that rejection is not evidence that the rejected original upload might have succeeded.

An operator must inspect the actual linked conversation before resolving the cursor in `telegram.json`, with the host stopped under separate authorization. Do not clear the flag or resend blindly. A partially delivered artifact notice from the pre-media production release has only a text-chunk cursor, not a caption plan. It is also held for inspection rather than guessing which content to replay after upgrade. Existing text-only cursors resume unchanged.

The transport also saves the latest 20 redacted `deliveryErrors` before fallback and exposes them in its snapshot. API entries preserve the provided description, HTTP status and API code. Later errors do not erase earlier entries. Network, incomplete-response and not-sent entries remain distinct. The history excludes request bodies and response message/file/chat objects; tests verify token/chat-ID redaction and persistence across restart.

## Verification and live-demo scope

`telegram-media-unit` uses the actual bridge against a mocked multipart endpoint. It covers one-call formatted captions/envelopes/actions/routing, album bytes/MIME/shared caption/per-item mappings, album limits/fallbacks, long-text preservation, Unicode/entities, security, ordering, rejection retries and ambiguous media/album blocking across restart.

`telegram-media-e2e` runs an isolated real host from an incoming Telegram update through coordinator/worker execution, artifact storage, notifier and outbox. Only the model and Bot API are fake. It verifies one-message photo/video results, a one-call mixed album, full long responses surviving the notifier, replies to a photo and a second album item reaching their original chat after the selected route changes, and no replay after restart. Both scripts run in deterministic CI without a browser.

The caption-first live album attempt returned HTTP 400. Its receipt did not save Telegram's description, and the temporary outbox was removed, so the historical error text is unavailable. Offline audit found and reproduced the inconsistent caption-placement flags against TDLib's exact 400 validation. The one-request guard then blocked the unsent fallback with a generic fetch error, so the outbox conservatively held it as uncertain. That flag does not make the original explicit 400 rejection ambiguous. The guard now uses the explicit not-sent error and records sanitized error code/description; it was not rerun.

The first live demos proved native photo/video visibility only. The later live wrapper/reply experiment was rejected by the owner as excessive splitting. Neither is evidence for this corrected caption-first UX. No more live sends are authorized unless the owner requests them. No deployment or owner-host restart is part of this PR.

`startTelegram({ receiveUpdates: false, ... })` remains available for bounded isolated outbound verification without competing with the running host's poller. It does not change host settings. Its reply mappings are local to that invocation, not installed in the unchanged production host.
