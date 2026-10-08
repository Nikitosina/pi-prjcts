/** Markdown (as models write it) to Telegram's `parse_mode: "HTML"` subset, and tag-aware splitting under the 4096 limit. */
export const TELEGRAM_LIMIT = 4096;
export const escapeHtml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
/** What the owner sees if Telegram refuses the HTML: tags dropped, entities decoded. */
export const htmlToPlain = (html: string) => html.replace(/<[^>]+>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", "\"").replaceAll("&amp;", "&");

const SAFE_URL = /^(https?:|mailto:|tg:)/i;
function inline(raw: string): string {
  const held: string[] = [];
  // Code spans and link targets are held out first, so nothing inside them is formatted; placeholders use characters escaping never produces.
  const hold = (html: string) => `\u0000${held.push(html) - 1}\u0000`;
  let text = raw.replace(/`([^`\n]+)`/g, (_, code: string) => hold(`<code>${escapeHtml(code)}</code>`));
  text = text.replace(/\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (_, label: string, url: string) => SAFE_URL.test(url) ? `${hold(`<a href="${escapeHtml(url).replaceAll("\"", "%22")}">`)}${label}${hold("</a>")}` : label);
  text = escapeHtml(text);
  text = text.replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, "<b>$1</b>").replace(/(^|[^\w])__(?=\S)([^_\n]*?\S)__(?!\w)/g, "$1<b>$2</b>");
  text = text.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1<i>$2</i>").replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1<i>$2</i>");
  text = text.replace(/~~(?=\S)([^~\n]*?\S)~~/g, "<s>$1</s>");
  return text.replace(/\u0000(\d+)\u0000/g, (_, index: string) => held[Number(index)]);
}

/** Headings become bold lines, lists `•`/numbered lines, `>` runs one blockquote, fences and pipe tables `<pre>`; an unterminated fence is closed. */
export function markdownToTelegramHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n"), out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      const code = escapeHtml(body.join("\n"));
      out.push(fence[2] ? `<pre><code class="language-${escapeHtml(fence[2])}">${code}</code></pre>` : `<pre>${code}</pre>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [line];
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) rows.push(lines[++i]);
      out.push(`<pre>${escapeHtml(rows.join("\n"))}</pre>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted = [line];
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) quoted.push(lines[++i]);
      out.push(`<blockquote>${quoted.map(item => inline(item.replace(/^\s*>\s?/, ""))).join("\n")}</blockquote>`);
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) { out.push(`<b>${inline(heading[1])}</b>`); continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("──────"); continue; }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) { out.push(`${bullet[1]}• ${inline(bullet[2])}`); continue; }
    out.push(inline(line));
  }
  return out.join("\n");
}

/**
 * Splits Telegram HTML into parts of at most `limit` characters, preferring line breaks. Tags open at a split are closed at the end of
 * one part and reopened at the start of the next, so every part is balanced; entities are never cut.
 */
export function splitTelegramHtml(html: string, limit = TELEGRAM_LIMIT): string[] {
  const parts: string[] = [], stack: { name: string; open: string }[] = [];
  let current = "";
  const closers = () => stack.map(tag => `</${tag.name}>`).reverse().join("");
  const flush = () => { if (htmlToPlain(current).trim()) parts.push(current + closers()); current = stack.map(tag => tag.open).join(""); };
  const room = () => limit - current.length - closers().length;
  for (const token of html.split(/(<[^>]+>)/)) {
    if (!token) continue;
    if (token.startsWith("<")) {
      const close = /^<\/([\w-]+)/.exec(token), open = /^<([\w-]+)/.exec(token);
      if (close) { current += token; stack.pop(); continue; }
      if (token.length + `</${open![1]}>`.length > room()) flush();
      stack.push({ name: open![1], open: token }); current += token;
      continue;
    }
    for (const line of token.split(/(?<=\n)/)) {
      let rest = line;
      while (rest) {
        if (rest.length <= room()) { current += rest; break; }
        if (htmlToPlain(current).trim() && rest.length <= limit - stack.map(tag => tag.open).join("").length - closers().length) { flush(); continue; }
        // A single line longer than a part: cut at the room left, never inside an entity.
        let cut = Math.max(1, room());
        const amp = rest.lastIndexOf("&", cut - 1);
        if (amp > 0 && rest.indexOf(";", amp) >= cut) cut = amp;
        current += rest.slice(0, cut); rest = rest.slice(cut); flush();
      }
    }
  }
  if (htmlToPlain(current).trim()) parts.push(current + closers());
  return parts;
}
