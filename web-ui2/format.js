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

/** Safe, small Markdown: input is escaped first; only http(s) links survive. */
export function markdown(value) {
  const parts = String(value ?? "").split(/```([^\n]*)\n([\s\S]*?)```/g);
  let out = "";
  for (let index = 0; index < parts.length; index++) {
    if (index % 3 === 1) continue;
    if (index % 3 === 2) {
      out += `<pre class="code"><code>${esc(parts[index])}</code></pre>`;
      continue;
    }
    out += blocks(parts[index]);
  }
  return out;
}
function inline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
}
function blocks(text) {
  const lines = text.split("\n"),
    out = [];
  let list = null,
    para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  for (const line of lines) {
    const heading = /^(#{1,4})\s+(.*)$/.exec(line),
      bullet = /^\s*[-*]\s+(.*)$/.exec(line),
      numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (heading) {
      flushPara();
      flushList();
      out.push(`<h${heading[1].length + 2} class="md-h">${inline(heading[2])}</h${heading[1].length + 2}>`);
    } else if (bullet || numbered) {
      flushPara();
      const tag = bullet ? "ul" : "ol";
      if (list?.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push((bullet ?? numbered)[1]);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out.join("");
}
