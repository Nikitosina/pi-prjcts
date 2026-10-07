# Uploads + knowledge search: failure cases (written before implementation)

Verified by `scripts/uploads-search-e2e.mjs` (fake model, headless Chrome, private HOME).

## Upload transport and storage
- U1 Upload endpoint accepts a request without the browser bearer token, or from another origin.
- U2 A file over 20 MiB is accepted (or the host buffers unbounded bytes before refusing); an empty file is accepted.
- U3 A filename with a path (`../x`, `a/b`), control characters or >240 chars is stored as given.
- U4 Unsupported binary (e.g. zip, random bytes) is stored as "text" and pollutes search.
- U5 Image type is guessed from the extension instead of magic bytes (a `.png` holding text is treated as an image, or a real webp is rejected).
- U6 PDF text is not extracted (search cannot find words inside the PDF), or a corrupt PDF crashes the host instead of storing the file with an extraction error.
- U7 A crash between writing bytes and metadata leaves a listed upload with missing bytes (metadata must be written last).
- U8 Uploads to an archived/deleted project or unknown project ID are accepted.
- U9 Re-uploading identical bytes with the same name creates duplicates.
- U10 Upload survives host restart: list, bytes and extracted text still there.
- U11 The old 32 KiB limit still applies to the new path (a 1 MiB text file is refused).

## Search tool
- S1 `projects_search` is missing from the coordinator, from chats other than Main, from workers, or from a coordinator reopened after restart (recovery must re-add it).
- S2 Search ignores uploads or ignores knowledge documents; ranks a document that merely mentions a common word above the one containing the rare query terms (no IDF).
- S3 Results lack enough identity to open the hit (path / upload ID + character offset) or return whole documents (unbounded output).
- S4 Empty / stop-word-only query throws an unhelpful error or returns everything.
- S5 Search returns stale content after a knowledge document is edited or an upload is deleted.
- S6 `projects_upload_read` reads outside the project's uploads (path traversal via ID) or returns unbounded text.
- S7 Search requires the library grant (it must not: uploads are owner-supplied knowledge), while worker-captured library evidence stays behind its grant.

## Composer attachments and images
- C1 Attaching in the composer (picker or drop) does not upload, or sends the message before uploads finish.
- C2 The coordinator receives no reference to the attachment (name + upload ID).
- C3 An image attachment is sent as image content to a text-only model (provider error), or not sent to an image-capable model.
- C4 An oversized image (> 5 MiB) is inlined into the model request.
- C5 Attachment IDs that do not belong to this project are accepted in `message`.
- C6 Attachment chips do not render in the transcript, or chips stay in the composer after send / leak to another chat.
- C7 A queued job re-admitted after restart loses its attachments.

## Knowledge tab
- K1 Uploads list missing; image not viewable; PDF/text not readable in the UI.
- K2 Drag-drop onto the Knowledge tab does nothing; picker button missing.
- K3 Delete leaves the file searchable.
- K4 Layout overflows at 390px.

## Leftovers
- L1 Observability health "Failed jobs" counts only the viewed chat; "Project" ignores a failing other chat.
- L2 CLI `owner-skills-catalog` returns only the first 16 candidates of a larger catalog.
