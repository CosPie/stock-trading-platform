export function renderMarkdown(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  const toc = [];
  const usedIds = new Map();
  let paragraph = [];
  let list = null;
  let quote = [];
  let code = [];
  let inCode = false;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    html.push(`<${list.type}>${list.items.map((item) => `<li>${renderListItem(item)}</li>`).join("")}</${list.type}>`);
    list = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    html.push(`<blockquote>${quote.map((item) => `<p>${inlineMarkdown(item)}</p>`).join("")}</blockquote>`);
    quote = [];
  };
  const flushCode = () => {
    if (!code.length) return;
    html.push(`<pre><code>${escapeHTML(code.join("\n"))}</code></pre>`);
    code = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trimEnd();
    if (line.trim().startsWith("```")) {
      if (inCode) {
        inCode = false;
        flushCode();
      } else {
        flushParagraph();
        flushList();
        flushQuote();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(raw);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      flushList();
      flushQuote();
      html.push("<hr>");
      continue;
    }
    if (isMarkdownTable(lines, i)) {
      flushParagraph();
      flushList();
      flushQuote();
      const tableRows = [];
      while (i < lines.length && lines[i].includes("|")) {
        tableRows.push(lines[i]);
        i += 1;
      }
      i -= 1;
      html.push(renderTable(tableRows));
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      flushQuote();
      const level = Math.min(heading[1].length, 3);
      const plain = stripMarkdown(heading[2]);
      const id = uniqueSlug(plain, usedIds);
      if (level <= 3) toc.push({ id, text: plain, level });
      html.push(`<h${level} id="${escapeAttr(id)}">${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const quoteMatch = /^>\s?(.*)$/.exec(line);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quote.push(quoteMatch[1]);
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    const ordered = /^\d+\.\s+(.+)$/.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      flushQuote();
      const type = bullet ? "ul" : "ol";
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push((bullet || ordered)[1]);
      continue;
    }
    flushList();
    flushQuote();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushQuote();
  flushCode();
  return { html: html.join(""), toc };
}

export function extractBriefMarkup(html) {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const styles = Array.from(doc.head.querySelectorAll("style"))
      .map((node) => node.outerHTML)
      .join("");
    const body = doc.body?.innerHTML?.trim();
    if (body) return `${styles}${body}`;
  } catch {
    // Fall through to raw HTML.
  }
  return html;
}

export function collectTocFromElement(root) {
  const usedIds = new Map();
  return Array.from(root.querySelectorAll("h1, h2, h3"))
    .map((heading) => {
      const level = Number(heading.tagName.slice(1));
      const text = stripMarkdown(heading.textContent || "章节");
      if (!heading.id) heading.id = uniqueSlug(text, usedIds);
      return { id: heading.id, text, level };
    })
    .filter((item) => item.text);
}

export function compactToc(toc) {
  return toc.length <= 48 ? toc : toc.filter((item) => item.level <= 2);
}

function isMarkdownTable(lines, index) {
  const current = lines[index] || "";
  const next = lines[index + 1] || "";
  return current.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next);
}

function renderTable(rows) {
  const parsed = rows
    .filter((row, index) => index !== 1)
    .map((row) =>
      row
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim()),
    );
  if (!parsed.length) return "";
  const [head, ...body] = parsed;
  return `<div class="markdown-table-wrap"><table><thead><tr>${head.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${body
    .map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

function renderListItem(item) {
  const task = /^\[( |x|X)\]\s+(.+)$/.exec(item);
  if (!task) return inlineMarkdown(item);
  const checked = task[1].toLowerCase() === "x" ? " checked" : "";
  return `<label class="task-item"><input type="checkbox" disabled${checked}> <span>${inlineMarkdown(task[2])}</span></label>`;
}

function inlineMarkdown(value) {
  return escapeHTML(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => `<a href="${escapeAttr(safeURL(href))}" target="_blank" rel="noreferrer">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function uniqueSlug(value, usedIds) {
  const base =
    String(value || "section")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "section";
  const count = usedIds.get(base) || 0;
  usedIds.set(base, count + 1);
  return count ? `${base}-${count + 1}` : base;
}

function stripMarkdown(value) {
  return String(value || "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

function safeURL(value) {
  const raw = String(value || "").trim();
  if (/^(https?:|mailto:)/i.test(raw)) return raw;
  if (raw.startsWith("#")) return raw;
  return "#";
}

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHTML(value);
}
