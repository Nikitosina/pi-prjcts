# Album HTTP 400 investigation

## What is known

The one authorized live album request returned HTTP 400 with `ok: false` and no returned messages. The script did not retain Telegram's description or the full wire request, and removed its temporary outbox. The exact historical description and deployed Telegram server revision are unavailable. Do not present the expected error below as a recovered response.

The original builder at `4031ce2150151d3118ad726fa8764c17103fa9cb` has a definite invalid field relationship. The first item's `show_caption_above_media` is true. The second omits it, which defaults to false. The corrected builder sets it true on both items. Caption text and `parse_mode: HTML` remain on the first item only.

| Field | Original photo | Original video | Corrected photo | Corrected video |
| --- | --- | --- | --- | --- |
| `media` | `attach://file0` | `attach://file1` | unchanged | unchanged |
| `show_caption_above_media` | `true` | omitted, effective `false` | `true` | `true` |
| `caption` / `parse_mode` | shared text / `HTML` | omitted | unchanged | omitted |

## Pinned official source

These references use Bot API commit `e3e9dd8e5b3d7ab8537cd5a10dc31d5ffa8f82d1` and its TDLib submodule commit `bc9c263e2bfee06aaab41e82db51a103376030bc`, not a moving `master` URL. This identifies the inspected source, not the unknown deployed server build.

- [Bot API's pinned TDLib submodule](https://api.github.com/repos/tdlib/telegram-bot-api/contents/td?ref=e3e9dd8e5b3d7ab8537cd5a10dc31d5ffa8f82d1).
- [InputMedia reads the optional boolean](https://github.com/tdlib/telegram-bot-api/blob/e3e9dd8e5b3d7ab8537cd5a10dc31d5ffa8f82d1/telegram-bot-api/Client.cpp#L12794-L12813). [Its default is false](https://github.com/tdlib/td/blob/bc9c263e2bfee06aaab41e82db51a103376030bc/tdutils/td/utils/JsonBuilder.h#L485).
- [Photo flag becomes `invert_media`](https://github.com/tdlib/td/blob/bc9c263e2bfee06aaab41e82db51a103376030bc/td/telegram/MessageContent.cpp#L4912), as does [the video flag](https://github.com/tdlib/td/blob/bc9c263e2bfee06aaab41e82db51a103376030bc/td/telegram/MessageContent.cpp#L4965).
- [The album validator](https://github.com/tdlib/td/blob/bc9c263e2bfee06aaab41e82db51a103376030bc/td/telegram/MessageContent.cpp#L5378-L5406) returns status 400 with `Parameter show_caption_above_media must be the same for all messages` when the flags differ.
- [The album send path calls this validator](https://github.com/tdlib/td/blob/bc9c263e2bfee06aaab41e82db51a103376030bc/td/telegram/MessagesManager.cpp#L21914-L21923). [Bot API submits `sendMessageAlbum`](https://github.com/tdlib/telegram-bot-api/blob/e3e9dd8e5b3d7ab8537cd5a10dc31d5ffa8f82d1/telegram-bot-api/Client.cpp#L14505-L14562).
- [Bot API's HTTP error formatter](https://github.com/tdlib/telegram-bot-api/blob/e3e9dd8e5b3d7ab8537cd5a10dc31d5ffa8f82d1/telegram-bot-api/Client.cpp#L164-L205) adds `Bad Request: ` and lowercases the first letter here. The exact expected API description is **`Bad Request: parameter show_caption_above_media must be the same for all messages`**. Tests now use that lowercase `parameter`, unlike the earlier mock.

## Executed source validation

An offline C++ harness compiles the pinned validator, its allowed/homogeneous-content helper functions, and the nonempty error-formatting body verbatim. Thin adapters supply data containers, status storage and string operations. It does not replace the flag comparison with a JavaScript rule. The extracted validator's SHA-256 is `c5eec64d2e80ae9b1997b64d460531abb2ecb4434cfed4b82b0e148aefd18977`.

The original bridge was loaded from the Git object above, with only relative import locations changed. The current bridge was loaded normally. Both ran the same notice and existing generated PNG/MP4 in isolated temporary homes. Example project/chat identities replaced private values. A capture-only transport serialized their actual FormData without forwarding any request. This is a redacted reconstruction, not the lost historical wire dump.

The captured InputMedia JSON went through the compiled source validator:

- Original effective flags `[true, false]`: status 400, with the exact TDLib message and expected Bot API description above.
- Corrected flags `[true, true]`: `Status::OK()`.
- Control flags `[false, false]`: `Status::OK()`.

This executes the authoritative album validation and error formatting. It is not a complete Bot API server or live delivery test. The full API send path needs Telegram authorization/backend access. No additional live send was authorized or attempted.

## Other HTTP 400 causes checked

- **Multipart references and JSON:** Both real bridge encodings contain `chat_id`, `file0`, `file1`, and the JSON `media` field. Python's independent MIME parser reports no defects. Each `attach://` name resolves to its expected file. The JSON has exactly two supported photo/video items, not an animation or an incompatible document mixture. [Official attachment lookup](https://github.com/tdlib/telegram-bot-api/blob/e3e9dd8e5b3d7ab8537cd5a10dc31d5ffa8f82d1/telegram-bot-api/Client.cpp#L10777-L10802) uses these field names.
- **File identity and formats:** The PNG is `image.png`, MIME `image/png`, 630 bytes, 320 by 180. Its SHA-256 is `75099d376212343c0dbaa8774f1d50af145619604976794df897dec21c28bc6f`. The MP4 is `video.mp4`, MIME `video/mp4`, 43,529 bytes, H.264/yuv420p, 320 by 180, two seconds. Its SHA-256 is `8e2c3f8ab7aa0b062d5bec1c4e23bfcf2899acaaec96383f3b6eae4cd646fcd6`. Both encodings contain the exact fixture bytes. `ffprobe` inspected them and `ffmpeg` decoded both completely without errors. Size, photo dimensions and aspect ratio fit the published limits. This does not prove Telegram's server-side processing outcome.
- **Caption and entities:** The reconstructed caption is identical before/after, has 230 Unicode characters after parsing, and contains only balanced `b` and `i` tags. [TDLib accepts those tags](https://github.com/tdlib/td/blob/bc9c263e2bfee06aaab41e82db51a103376030bc/td/telegram/MessageEntity.cpp#L3351-L3355) and [counts caption characters with `utf8_length`](https://github.com/tdlib/td/blob/bc9c263e2bfee06aaab41e82db51a103376030bc/td/telegram/MessageContent.cpp#L5293-L5295). The existing unit tests also cover the 1024 boundary, escaped entities and astral Unicode. The original private header text was not saved, so 230 is not a claim about the historical caption length.
- **Unsupported fields:** The reconstructed request has no album `reply_markup`, no malformed reply target, and no extra top-level caption/parse mode. `show_caption_above_media` itself is supported; the invalid part was its inconsistent value across items.

No other violation was found in the reconstruction. The proven field bug is the leading explanation for the historical 400. The lost description prevents proving that it was the first error the live server reported.

## Future diagnostics

The production transport now persists the latest 20 `deliveryErrors` in its existing private state and exposes them in the redacted snapshot. API errors retain method, time, HTTP status, API code, the exact sanitized description and whether Telegram provided it. The record is saved before fallback, so later fallback errors, successful fallback or polling cannot overwrite the original evidence. Network failures and requests blocked before transmission have separate kinds. Request bodies and response message/file/chat objects are not logged.

The shared redactor removes raw and URL-encoded bot tokens, known request/owner/bot identifiers, and labeled chat IDs. Tests check exact retained wording, preservation of byte offset 17, redaction, multiple fallback errors, restart persistence, and API rejection versus a locally blocked unsent fallback. The isolated demo guard uses this redactor too, without a description-length clip, but was not rerun.

The corrected request is ready for a separately approved live test. It still contains one photo/video album with one normal identity/body/footer caption and no wrapper messages. Live acceptance and client rendering remain unverified. No merge, deployment or owner-host restart is part of this investigation.
