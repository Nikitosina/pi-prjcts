// Unit: which Finder drops and pastes supply a full local path (web/path-drop.js). Failure cases: composer-paths-failures.md.
import assert from "node:assert/strict";
import { PathSource, pathsFromTransfer } from "../web/path-drop.js";

const transfer = ({ data = {}, files = 0 } = {}) => ({
  types: [...Object.keys(data), ...(files ? ["Files"] : [])],
  files: { length: files },
  getData: (type) => data[type] ?? "",
});
const paths = (data, files) => pathsFromTransfer(transfer({ data, files }));
const cases = [
  [
    "P1 uri-list file URL becomes a plain path",
    () =>
      assert.deepEqual(paths({ "text/uri-list": "file:///Users/a/notes.txt\r\n" }), {
        source: PathSource.Path,
        paths: ["/Users/a/notes.txt"],
      }),
  ],
  [
    "P1 text/plain made only of file URLs counts",
    () => assert.deepEqual(paths({ "text/plain": "file:///tmp/a.txt" }).paths, ["/tmp/a.txt"]),
  ],
  [
    "P2 spaces, hash, percent and Unicode decode once",
    () =>
      assert.deepEqual(paths({ "text/uri-list": "file:///Users/a/Мои%20файлы/100%25%20%23%231%20%E2%82%AC.txt" }).paths, [
        "/Users/a/Мои файлы/100% ##1 €.txt",
      ]),
  ],
  [
    "P2 decomposed Unicode is kept as the URL gave it",
    () => assert.deepEqual(paths({ "text/uri-list": "file:///a/e%CC%81.txt" }).paths, ["/a/e\u0301.txt"]),
  ],
  [
    "P1 localhost host and a directory slash",
    () => assert.deepEqual(paths({ "text/uri-list": "file://localhost/Users/a/Dir/" }).paths, ["/Users/a/Dir"]),
  ],
  [
    "P11 every line is one path; comments are skipped",
    () =>
      assert.deepEqual(paths({ "text/uri-list": "# Finder\r\nfile:///a/one%20two.txt\r\nfile:///b/c.txt\r\n" }).paths, [
        "/a/one two.txt",
        "/b/c.txt",
      ]),
  ],
  [
    "P3 a remote host is not a local path",
    () => assert.equal(paths({ "text/uri-list": "file://server/share/a.txt" }).source, PathSource.None),
  ],
  [
    "P3 an https link is left to the browser",
    () => assert.equal(paths({ "text/uri-list": "https://example.com/a" }).source, PathSource.None),
  ],
  ["P3 a malformed escape is refused", () => assert.equal(paths({ "text/uri-list": "file:///a/%E0%A4%A" }).source, PathSource.None)],
  ["P3 a NUL byte is refused", () => assert.equal(paths({ "text/uri-list": "file:///a/b%00c" }).source, PathSource.None)],
  [
    "P3 one bad line refuses the whole transfer",
    () => assert.equal(paths({ "text/uri-list": "file:///a/b\r\nhttps://x.y" }).source, PathSource.None),
  ],
  [
    "P4 a File alone supplies no path and invents none",
    () => assert.deepEqual(pathsFromTransfer(transfer({ files: 1 })), { source: PathSource.FileOnly, paths: [] }),
  ],
  [
    "P5 a File with a basename in text/plain is file-only",
    () => assert.deepEqual(paths({ "text/plain": "notes.txt" }, 1), { source: PathSource.FileOnly, paths: [] }),
  ],
  ["P1 a file URL wins over a File", () => assert.deepEqual(paths({ "text/uri-list": "file:///a/b.txt" }, 1).paths, ["/a/b.txt"])],
  [
    "P6 plain text, even a path, is left to the browser",
    () => assert.deepEqual(paths({ "text/plain": "/Users/a/Copy as Pathname.txt" }), { source: PathSource.None, paths: [] }),
  ],
  ["P3 a relative file URL names no absolute path", () => assert.equal(paths({ "text/plain": "file:notes.txt" }).source, PathSource.None)],
  [
    "P3 an encoded slash would add a directory",
    () => assert.equal(paths({ "text/uri-list": "file:///tmp/a%2Fb" }).source, PathSource.None),
  ],
  [
    "P6 a File next to an absolute path in text/plain leaves the paste to the browser",
    () => assert.deepEqual(paths({ "text/plain": "/Users/a/My File.txt" }, 1), { source: PathSource.None, paths: [] }),
  ],
  [
    "P6 a note above a file URL in text/plain is not dropped",
    () => assert.equal(paths({ "text/plain": "# Keep this note\nfile:///tmp/a" }).source, PathSource.None),
  ],
  ["empty transfer", () => assert.deepEqual(paths({}), { source: PathSource.None, paths: [] })],
];
let failed = 0;
for (const [name, run] of cases) {
  try {
    run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n${error.message}`);
  }
}
if (failed) process.exit(1);
console.log(`${cases.length} passed`);
