import { initial, probe } from "./shell.js";
import { esc } from "./format.js";
import { NOT_TICKETS, ticketTemplate } from "./prs.js";
import { refChipHtml, refHtmlPattern, refIcons, unesc } from "./composer.js";

export function renderMarkdown(value, options) {
  if (!probe) return parseMarkdown(value, options);
  const start = performance.now(),
    html = parseMarkdown(value, options);
  probe.markdown.push({ text: String(value), ms: performance.now() - start });
  return html;
}
function parseMarkdown(value, options = {}) {
  const inlineMarkdown = (text) => inlineRefsMarkdown(text, options.refs);
  const blocks = String(value ?? "").split(/```([^\n]*)\n([\s\S]*?)```/g);
  return blocks
    .map((part, index) => {
      if (index % 3 === 1) return "";
      if (index % 3 === 2 && /^(mermaid|flowchart)$/.test(blocks[index - 1].trim()))
        return `<pre class="mermaid-src" data-mermaid="${esc(blocks[index - 1].trim() === "flowchart" && !/^\s*(flowchart|graph)\b/.test(part) ? `flowchart TD\n${part}` : part)}"><code>${esc(part)}</code></pre>`;
      if (index % 3 === 2)
        return blocks[index - 1].trim() === "diff"
          ? `<pre class="diff"><code>${part
              .split("\n")
              .map((line) => `<span class="${line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : ""}">${esc(line)}</span>`)
              .join("\n")}</code></pre>`
          : `<pre><code>${esc(part)}</code></pre>`;
      const lines = part.split("\n"),
        out = [];
      let list = null,
        quote = [];
      const flushList = () => {
        if (list) {
          out.push(
            `<${list.tag}${list.start > 1 ? ` start="${list.start}"` : ""}>${list.items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</${list.tag}>`,
          );
          list = null;
        }
      };
      const flushQuote = () => {
        if (quote.length) {
          out.push(`<blockquote>${quote.map(inlineMarkdown).join("<br>")}</blockquote>`);
          quote = [];
        }
      };
      const cells = (row) =>
        row
          .trim()
          .replace(/^\|/, "")
          .replace(/(?<!\\)\|$/, "")
          .split(/(?<!\\)\|/)
          .map((cell) => cell.trim().replaceAll("\\|", "|"));
      const separator = (row) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(row ?? "");
      for (let at = 0; at < lines.length; at++) {
        const line = lines[at];
        // GFM table: a header row with pipes, then a --- separator row; body rows run until a line without a pipe.
        if (line.includes("|") && separator(lines[at + 1])) {
          flushList();
          flushQuote();
          const head = cells(line),
            align = cells(lines[at + 1]).map((cell) => (cell.endsWith(":") ? (cell.startsWith(":") ? "center" : "right") : ""));
          const cell = (tag, text, index) =>
            `<${tag}${align[index] ? ` class="align-${align[index]}"` : ""}>${inlineMarkdown(text ?? "")}</${tag}>`;
          const body = [];
          for (at += 2; at < lines.length && lines[at].includes("|") && lines[at].trim(); at++) body.push(cells(lines[at]));
          at--;
          out.push(
            `<div class="table-wrap"><table><thead><tr>${head.map((text, index) => cell("th", text, index)).join("")}</tr></thead><tbody>${body.map((row) => `<tr>${head.map((_, index) => cell("td", row[index], index)).join("")}</tr>`).join("")}</tbody></table></div>`,
          );
          continue;
        }
        const ordered = /^\s*(\d+)[.)]\s+(.+)$/.exec(line),
          unordered = /^\s*[-*]\s+(.+)$/.exec(line);
        if (ordered || unordered) {
          flushQuote();
          const tag = ordered ? "ol" : "ul";
          if (list?.tag !== tag) flushList();
          if (!list) list = { tag, items: [], start: ordered ? Number(ordered[1]) : 1 };
          list.items.push(ordered ? ordered[2] : unordered[1]);
          continue;
        }
        // Blank lines between items keep one list; indented lines continue the last item.
        if (list && !line.trim()) continue;
        if (list && /^\s{2,}\S/.test(line)) {
          list.items[list.items.length - 1] += ` ${line.trim()}`;
          continue;
        }
        flushList();
        const quoted = /^>\s?(.*)$/.exec(line);
        if (quoted) {
          quote.push(quoted[1]);
          continue;
        }
        flushQuote();
        const heading = /^(#{1,6})\s+(.+)$/.exec(line);
        if (heading) out.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`);
        else if (line.trim()) out.push(`<p>${inlineMarkdown(line)}</p>`);
      }
      flushList();
      flushQuote();
      return out.join("");
    })
    .join("");
}
if (initial.searchParams.get("e2e") === "1") window.__projectsRenderMarkdown = renderMarkdown;
// Mermaid fences first render as plain code blocks. The same-origin build loads on first use and swaps in the diagram; any failure leaves the code block.
const mermaidSvgs = new Map();
let mermaidLoad = null;
function loadMermaid() {
  mermaidLoad ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/vendor/mermaid.min.js";
    script.onload = () => {
      const api = globalThis.__esbuild_esm_mermaid_nm?.mermaid;
      resolve(api?.default ?? api);
    };
    script.onerror = () => {
      mermaidLoad = null;
      reject(new Error("Mermaid failed to load"));
    };
    document.head.append(script);
  });
  return mermaidLoad;
}
let mermaidSeq = 0,
  mermaidQueue = Promise.resolve();
function hydrateMermaid(root = document) {
  for (const node of root.querySelectorAll("pre[data-mermaid]:not([data-state])")) {
    const source = node.dataset.mermaid,
      dark = document.documentElement.dataset.theme === "dark",
      key = `${dark ? "d" : "l"}:${source}`;
    const show = (svg) => {
      if (!node.isConnected) return;
      const box = document.createElement("div");
      box.className = "mermaid-diagram";
      box.innerHTML = svg;
      node.replaceWith(box);
    };
    node.dataset.state = "pending";
    if (mermaidSvgs.has(key)) {
      const cached = mermaidSvgs.get(key);
      if (cached) show(cached);
      else node.dataset.state = "failed";
      continue;
    }
    // Renders run one at a time: mermaid keeps global state while it lays out.
    mermaidQueue = mermaidQueue.then(async () => {
      try {
        const mermaid = await loadMermaid();
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral", suppressErrorRendering: true });
        const id = `mermaid-${++mermaidSeq}`;
        // Mermaid parks its work in <div id="d…"> (and the svg itself on a parse error); clear both before the diagram takes the svg's id.
        let svg = null;
        try {
          ({ svg } = await mermaid.render(id, source));
        } finally {
          document.getElementById(`d${id}`)?.remove();
          document.getElementById(id)?.remove();
        }
        mermaidSvgs.set(key, svg);
        show(svg);
      } catch {
        mermaidSvgs.set(key, null);
        node.dataset.state = "failed";
      }
    });
  }
}
new MutationObserver(() => hydrateMermaid()).observe(document.body, { childList: true, subtree: true });
function inlineRefsMarkdown(value, refs) {
  const code = [];
  let text = esc(value).replace(/`([^`]+)`/g, (_, body) => {
    const key = `\u0000${code.length}\u0000`;
    code.push(`<code>${body}</code>`);
    return key;
  });
  // Worker artifacts: ![caption](artifact:<thread>/<path>) inline (images, videos), [name](artifact:…) as a download; hydrated by hydrateArtifacts().
  text = text.replace(/(!?)\[([^\]]*)\]\(artifact:([a-f0-9-]{36})\/([^)\s]+)\)/g, (all, bang, label, thread, escapedPath) => {
    const path = escapedPath
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
    if (path.split("/").some((part) => !part || part === "." || part === "..")) return all;
    const key = `\u0000${code.length}\u0000`;
    code.push(
      `<span class="artifact-ref" data-artifact-thread="${thread}" data-artifact-path="${esc(path)}" data-inline="${bang ? "1" : ""}">${label || esc(path)}</span>`,
    );
    return key;
  });
  const hold = (html) => {
    const key = `\u0000${code.length}\u0000`;
    code.push(html);
    return key;
  };
  // External images are links, never loaded: a prompt-injected image URL must not leak data by being fetched.
  text = text.replace(/!?\[([^\]]+)\]\(([^)]+)\)/g, (all, label, escapedHref) => {
    try {
      const url = new URL(unesc(escapedHref));
      return ["http:", "https:", "mailto:"].includes(url.protocol)
        ? hold(`<a href="${esc(url.href)}" rel="noopener noreferrer" target="_blank">${label}</a>`)
        : label;
    } catch {
      return label;
    }
  });
  text = text.replace(/https?:\/\/(?:(?!&quot;|&#39;|&lt;|&gt;)[^\s\u0000])+/g, (all) => {
    const href = all.replace(/[.,;:!?)\]]+$/, ""),
      tail = all.slice(href.length);
    try {
      const url = new URL(unesc(href));
      return hold(`<a href="${esc(url.href)}" rel="noopener noreferrer" target="_blank">${href}</a>`) + tail;
    } catch {
      return all;
    }
  });
  if (refs)
    text = text.replace(refHtmlPattern, (all, skill, kind, quoted, bare, pr) =>
      hold(refChipHtml(all, skill, kind, quoted, bare, pr, refs)),
    );
  const ticket = ticketTemplate();
  if (ticket)
    text = text.replace(/(?<![\w/.-])([A-Z][A-Z0-9]{1,15})-([1-9]\d{0,7})(?![\w-])/g, (all, queue) =>
      NOT_TICKETS.has(queue)
        ? all
        : hold(
            `<a class="ref-chip ref-ticket" href="${esc(ticket.replace("{key}", all))}" target="_blank" rel="noopener noreferrer" title="Open ${all}">${refIcons.issue}<span>${all}</span></a>`,
          ),
    );
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => code[Number(index)]);
}
