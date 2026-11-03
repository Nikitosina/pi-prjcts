// Escaping and small formatters. Everything from providers, transcripts and plugins goes through `esc` or `markdown`.

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
export function clip(value, size) {
  const text = String(value ?? "");
  return text.length > size ? `${text.slice(0, size - 1)}…` : text;
}
export function oneLine(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}
export function dur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  const min = Math.round(ms / 60000);
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
}
export function ago(at) {
  const time = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(time) || time <= 0) return "";
  const s = Math.round((Date.now() - time) / 1000);
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
export function clock(at) {
  const time = typeof at === "number" ? at : Date.parse(at);
  return Number.isFinite(time) ? new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}
export function tokens(n) {
  if (!Number.isFinite(n)) return "–";
  return n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}
export function usd(n) {
  return Number.isFinite(n) ? `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}` : "–";
}
export function shortModel(ref) {
  const name =
    String(ref ?? "")
      .split("/")
      .pop() ?? "";
  return name.replace(/^claude-/, "").replace(/-\d{8}(-v\d.*)?$/, "");
}

/**
 * Safe Markdown for agent text: GFM tables, nested and numbered lists, quotes, fenced code, links. Every piece of input is escaped;
 * links survive only for http(s), remote images stay links (never fetched), and `artifact:` references become media slots that
 * `hydrateMedia` fills through the host's token-authenticated route.
 */
export function markdown(value) {
  return blocks(
    String(value ?? "")
      .replace(/\r\n?/g, "\n")
      .replace(/\u0000/g, "")
      .split("\n"),
  );
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/,
  HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/,
  RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/,
  QUOTE = /^ {0,3}>\s?/,
  ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/,
  DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const indentOf = (line) => /^\s*/.exec(line)[0].replace(/\t/g, "    ").length;
const tableStarts = (lines, i) =>
  lines[i].includes("|") && i + 1 < lines.length && lines[i + 1].includes("|") && DELIMITER.test(lines[i + 1]);
const startsBlock = (lines, i) =>
  FENCE.test(lines[i]) ||
  HEADING.test(lines[i]) ||
  RULE.test(lines[i]) ||
  QUOTE.test(lines[i]) ||
  ITEM.test(lines[i]) ||
  tableStarts(lines, i);

/** `tight` paragraphs (list items without blank lines) render as bare inline text. */
function blocks(lines, tight = false) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const body = [];
      for (i++; i < lines.length && !new RegExp(`^ {0,3}${fence[1][0] === "`" ? "`" : "~"}{${fence[1].length},}\\s*$`).test(lines[i]); i++)
        body.push(lines[i]);
      i++;
      out.push(`<pre class="code"><code${fence[2] ? ` data-lang="${esc(fence[2])}"` : ""}>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level} class="md-h">${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) body.push(lines[i].replace(QUOTE, ""));
      out.push(`<blockquote>${blocks(body)}</blockquote>`);
      continue;
    }
    if (tableStarts(lines, i)) {
      i = table(lines, i, out);
      continue;
    }
    if (ITEM.test(line)) {
      i = list(lines, i, out);
      continue;
    }
    const para = [line];
    for (i++; i < lines.length && lines[i].trim() && !startsBlock(lines, i); i++) para.push(lines[i]);
    const text = para.map((part) => inline(part.trim())).join("<br>");
    out.push(tight ? text : `<p>${text}</p>`);
  }
  return out.join("");
}

function cells(line) {
  const parts = [];
  let current = "",
    code = false;
  const text = line
    .trim()
    .replace(/^\|/, "")
    .replace(/(^|[^\\])\|$/, "$1");
  for (let k = 0; k < text.length; k++) {
    const char = text[k];
    if (char === "\\" && text[k + 1] === "|") {
      current += "|";
      k++;
    } else if (char === "`") {
      code = !code;
      current += char;
    } else if (char === "|" && !code) {
      parts.push(current.trim());
      current = "";
    } else current += char;
  }
  parts.push(current.trim());
  return parts;
}
/** A GFM table inside its own horizontal scroller; alignment from the delimiter row. */
function table(lines, i, out) {
  const head = cells(lines[i]),
    align = cells(lines[i + 1]).map((cell) =>
      /^:-+:$/.test(cell) ? "center" : /^-+:$/.test(cell) ? "right" : /^:-+$/.test(cell) ? "left" : "",
    );
  const attr = (index) => (align[index] ? ` class="align-${align[index]}"` : "");
  const rows = [];
  for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes("|"); i++) rows.push(cells(lines[i]));
  out.push(
    `<div class="table-wrap"><table><thead><tr>${head.map((cell, index) => `<th${attr(index)}>${inline(cell)}</th>`).join("")}</tr></thead>${
      rows.length
        ? `<tbody>${rows.map((row) => `<tr>${head.map((_, index) => `<td${attr(index)}>${inline(row[index] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody>`
        : ""
    }</table></div>`,
  );
  return i;
}
/** One list and everything nested under it; items continue on lines indented to their content column. */
function list(lines, i, out) {
  const first = ITEM.exec(lines[i]),
    indent = indentOf(lines[i]),
    ordered = /\d/.test(first[2]),
    items = [];
  let loose = false;
  while (i < lines.length) {
    const match = ITEM.exec(lines[i]);
    if (!match || indentOf(lines[i]) !== indent || /\d/.test(match[2]) !== ordered) break;
    const column = indent + match[2].length + 1,
      body = [match[3] ?? ""];
    for (i++; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) {
        const next = lines.slice(i + 1).find((part) => part.trim());
        if (next === undefined || indentOf(next) < column) {
          const sibling = next !== undefined && ITEM.exec(next);
          if (sibling && indentOf(next) === indent && /\d/.test(sibling[2]) === ordered) loose = true;
          break;
        }
        body.push("");
        continue;
      }
      if (indentOf(line) >= column || (indentOf(line) > indent && ITEM.test(line)))
        body.push(line.replace(/^\s*/, (lead) => " ".repeat(Math.max(0, indentOf(lead) - column))));
      else if (!startsBlock(lines, i) && body.at(-1)?.trim()) body.push(line.trim());
      else break;
    }
    items.push(body);
    while (i < lines.length && !lines[i].trim()) {
      const next = lines.slice(i).find((part) => part.trim());
      const sibling = next && ITEM.exec(next);
      if (!sibling || indentOf(next) !== indent || /\d/.test(sibling[2]) !== ordered) break;
      i++;
    }
  }
  const tag = ordered ? "ol" : "ul",
    start = ordered ? parseInt(first[2], 10) : 1;
  out.push(`<${tag}${start !== 1 ? ` start="${start}"` : ""}>${items.map((body) => `<li>${blocks(body, !loose)}</li>`).join("")}</${tag}>`);
  return i;
}

const ARTIFACT = /^artifact:([a-f0-9-]{36})\/(.+)$/,
  MEDIA = /\.(png|jpe?g|webp|gif)$/i;
const anchor = (href, label) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
/** Only absolute http(s) URLs become links. */
function webUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
/** `![caption](artifact:<thread>/<path>)` is an inline image slot; any other artifact is a download button. Paths with empty, . or .. segments stay text. */
function artifactHtml(bang, label, thread, path) {
  if (path.split("/").some((part) => !part || part === "." || part === "..")) return null;
  const name = path.split("/").at(-1),
    key = `${thread}/${path}`;
  if (bang && MEDIA.test(path))
    return `<span class="media" data-media data-artifact="${esc(key)}" data-label="${esc(label || name)}" data-state="idle"><span class="media-note">▣ ${esc(label || name)}</span></span>`;
  return `<button type="button" class="link-btn artifact-open" data-artifact-open="${esc(key)}" title="${esc(path)}">${esc(label || name)}</button>`;
}
function inline(raw) {
  const held = [];
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
  let text = raw
    // Code spans first: nothing inside them is formatted.
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, ticks, body) => hold(`<code>${esc(body.trim() || body)}</code>`))
    .replace(/(!?)\[([^\]\n]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g, (all, bang, label, href) => {
      const artifact = ARTIFACT.exec(href);
      if (artifact) return hold(artifactHtml(bang, label, artifact[1], artifact[2]) ?? esc(all));
      const url = webUrl(href);
      if (!url) return hold(esc(all));
      // A remote image is a link, never fetched: a prompt-injected URL must not learn that the chat was read.
      return hold(anchor(url, bang ? `▣ ${esc(label || url)}` : emphasis(esc(label || url))));
    })
    .replace(/(^|[\s(])(https?:\/\/[^\s<>"]+)/g, (all, lead, link) => {
      let tail = "";
      // Trailing sentence punctuation and an unbalanced closing bracket are not part of the URL.
      while (/[.,;:!?'"\])]$/.test(link) && !(link.endsWith(")") && (link.match(/\(/g)?.length ?? 0) >= (link.match(/\)/g)?.length ?? 0))) {
        tail = link.at(-1) + tail;
        link = link.slice(0, -1);
      }
      const url = webUrl(link);
      return url ? `${lead}${hold(anchor(url, esc(link)))}${tail}` : all;
    });
  text = emphasis(esc(text));
  // A held piece can hold another (a code span inside a link label); restore until none is left.
  while (/\u0000\d+\u0000/.test(text)) text = text.replace(/\u0000(\d+)\u0000/g, (_, index) => held[Number(index)]);
  return text;
}
function emphasis(html) {
  return html
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>")
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*]*?[^\s*])\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
}

const kb = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
/** Slots for a transcript item's images (`{ ref, mime, bytes }`); `hydrateMedia` loads them as they near the viewport. */
export function imagesHtml(images) {
  if (!images?.length) return "";
  return `<div class="media-row">${images
    .map((image) => {
      const label = `Image · ${String(image.mime ?? "").replace(/^image\//, "")} · ${kb(image.bytes ?? 0)}`;
      return `<span class="media" data-media data-image-ref="${esc(image.ref)}" data-label="${esc(label)}" data-state="idle"><span class="media-note">▣ ${esc(label)}</span></span>`;
    })
    .join("")}</div>`;
}
