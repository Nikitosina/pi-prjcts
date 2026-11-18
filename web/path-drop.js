// Full local paths for the composer: a `file:` URL that a browser hands over on a drop or paste becomes a plain path.
// A bare File is never turned into a path (browsers hide it), and nothing here reads file contents.

export const PathSource = { Path: "path", FileOnly: "file-only", None: "none" };

/** The one-line explanation shown when a drop or paste carries a File without its path. */
export const FILE_ONLY_NOTE =
  "The browser gave only the file name, not its path. In Finder select the file, press ⌥⌘C (Copy as Pathname), then paste here.";

/** The plain path a local `file:` URL names; null for another scheme, a remote host or an escape that does not decode. */
function localPath(line) {
  if (!/^file:\//i.test(line)) return null;
  let url;
  try {
    url = new URL(line);
  } catch {
    return null;
  }
  if (url.protocol !== "file:" || (url.hostname !== "" && url.hostname !== "localhost")) return null;
  if (/%2f/i.test(url.pathname)) return null;
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (/[\0\r\n]/.test(path)) return null;
  return path.length > 1 ? path.replace(/\/$/, "") : path;
}

/** Paths when every line is a local file URL, else null (one foreign line leaves the whole transfer to the browser). */
function pathsFrom(text, comments) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() && !(comments && line.startsWith("#")));
  const paths = lines.map((line) => localPath(line.trim()));
  return lines.length && paths.every((path) => path !== null) ? paths : null;
}

/** What a DataTransfer (drop) or clipboardData (paste) supplies: file URLs as paths, a File with no URL, or nothing for the browser to handle. */
export function pathsFromTransfer(transfer) {
  const types = [...(transfer?.types ?? [])];
  for (const type of ["text/uri-list", "text/plain"]) {
    const paths = types.includes(type) ? pathsFrom(transfer.getData(type), type === "text/uri-list") : null;
    if (paths) return { source: PathSource.Path, paths };
  }
  if (types.includes("text/plain") && /^\/[^\r\n]*$/.test(transfer.getData("text/plain").trim()))
    return { source: PathSource.None, paths: [] };
  const hasFile = types.includes("Files") || transfer?.files?.length > 0;
  return { source: hasFile ? PathSource.FileOnly : PathSource.None, paths: [] };
}

/** Puts `text` into the textarea and returns whether it fit. A drop keeps the selection and inserts after it; a paste replaces it. */
export function insertText(box, text, { replaceSelection }) {
  const start = replaceSelection ? box.selectionStart : box.selectionEnd,
    end = box.selectionEnd;
  if (box.value.length - (end - start) + text.length > box.maxLength) return false;
  box.focus();
  box.setRangeText(text, start, end, "end");
  box.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}
