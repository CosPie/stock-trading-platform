const reportState = {
  report: null,
  view: new URLSearchParams(window.location.search).get("view") || "raw",
  rawToc: [],
  briefToc: [],
  headingObserver: null,
  searchQuery: "",
  searchTimer: null,
};

const reportEls = {
  title: document.getElementById("reportTitle"),
  meta: document.getElementById("reportMeta"),
  generate: document.getElementById("generateBriefPageButton"),
  briefView: document.getElementById("briefView"),
  rawView: document.getElementById("rawView"),
  briefEmpty: document.getElementById("briefEmpty"),
  briefContent: document.getElementById("briefContent"),
  rawContent: document.getElementById("rawReportContent"),
  tocList: document.getElementById("reportTocList"),
  searchInput: document.getElementById("reportSearchInput"),
  searchCount: document.getElementById("reportSearchCount"),
  copyLink: document.getElementById("copyReportLinkButton"),
  print: document.getElementById("printReportButton"),
  backToTop: document.getElementById("backToTopButton"),
};

initReportPage();

function reportID() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

async function initReportPage() {
  document.querySelectorAll(".viewer-tab").forEach((button) => {
    button.addEventListener("click", () => setReportView(button.dataset.view));
  });
  reportEls.generate.addEventListener("click", generateBrief);
  reportEls.searchInput.addEventListener("input", handleReportSearchInput);
  reportEls.searchInput.addEventListener("keydown", handleReportSearchKeydown);
  reportEls.copyLink.addEventListener("click", copyReportLink);
  reportEls.print.addEventListener("click", () => window.print());
  reportEls.backToTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  document.addEventListener("keydown", handleReportShortcut);
  window.addEventListener("scroll", updateBackToTopVisibility, { passive: true });
  await loadReport();
  setReportView(reportState.view);
}

async function loadReport() {
  try {
    const report = await api(`/api/reports/${encodeURIComponent(reportID())}`);
    reportState.report = report;
    reportEls.title.textContent = `${report.ticker} 报告`;
    reportEls.meta.textContent = `${report.analysisDate} · ${report.depth} · ${statusText(report.status)}`;
    const rendered = renderMarkdown(report.reportMarkdown || report.summary || report.error || "暂无报告内容。");
    reportEls.rawContent.innerHTML = rendered.html;
    reportState.rawToc = compactToc(rendered.toc);
    renderBrief(report.briefHtml);
    reportEls.generate.disabled = hasBrief(report) || report.status !== "complete" || !report.reportMarkdown;
    reportEls.generate.textContent = hasBrief(report) ? "已生成分析简报" : "生成分析简报";
    updateToc();
  } catch (error) {
    reportState.view = "raw";
    reportEls.title.textContent = "报告加载失败";
    reportEls.meta.textContent = "请返回首页重新选择报告。";
    reportEls.generate.disabled = true;
    reportEls.searchInput.disabled = true;
    reportEls.rawContent.innerHTML = renderErrorState("无法加载报告", error.message);
    reportEls.tocList.innerHTML = "<span>无法生成目录</span>";
  }
}

function renderBrief(html) {
  const content = String(html || "").trim();
  const hasContent = content.length > 0;
  reportEls.briefEmpty.hidden = hasContent;
  reportEls.briefContent.hidden = !hasContent;
  if (!hasContent) {
    reportEls.briefContent.innerHTML = "";
    reportState.briefToc = [];
    restoreBriefEmptyDefault();
    return;
  }
  reportEls.briefContent.innerHTML = extractBriefMarkup(content);
  reportState.briefToc = compactToc(collectTocFromElement(reportEls.briefContent));
}

function extractBriefMarkup(html) {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const styles = Array.from(doc.head.querySelectorAll("style"))
      .map((node) => node.outerHTML)
      .join("");
    const body = doc.body?.innerHTML?.trim();
    if (body) return `${styles}${body}`;
  } catch {
    // Fall back to raw HTML below.
  }
  return html;
}

function restoreBriefEmptyDefault() {
  reportEls.briefEmpty.innerHTML =
    '<h2>还没有分析简报</h2><p>点击“生成分析简报”，系统会调用 LLM，把原始报告改写成更容易阅读的 HTML 简报。</p>';
}

function hasBrief(report) {
  return Boolean(String(report?.briefHtml || "").trim());
}

async function generateBrief() {
  reportEls.generate.disabled = true;
  reportEls.generate.textContent = "生成中...";
  reportEls.briefEmpty.innerHTML = "<h2>正在生成分析简报</h2><p>请稍等，LLM 正在把原始报告改写成更容易阅读的页面。</p>";
  setReportView("brief");
  try {
    const report = await api(`/api/reports/${encodeURIComponent(reportID())}/brief`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    reportState.report = report;
    renderBrief(report.briefHtml);
    updateToc();
    applyReportSearch({ scroll: false });
    reportEls.generate.disabled = true;
    reportEls.generate.textContent = "已生成分析简报";
  } catch (error) {
    reportEls.briefEmpty.hidden = false;
    reportEls.briefContent.hidden = true;
    reportEls.briefContent.innerHTML = "";
    reportEls.briefEmpty.innerHTML = `<h2>生成失败</h2><p>${escapeHTML(error.message)}</p>`;
    reportEls.generate.disabled = false;
    reportEls.generate.textContent = "生成分析简报";
  }
}

function setReportView(view) {
  reportState.view = view;
  document.querySelectorAll(".viewer-tab").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === view);
  });
  reportEls.briefView.hidden = view !== "brief";
  reportEls.rawView.hidden = view !== "raw";
  if (view === "brief" && reportState.report) {
    renderBrief(reportState.report.briefHtml);
  }
  updateToc();
  applyReportSearch({ scroll: false });
}

function updateToc() {
  const toc = reportState.view === "brief" ? reportState.briefToc : reportState.rawToc;
  if (!toc.length) {
    reportEls.tocList.innerHTML = "<span>暂无目录</span>";
    observeActiveHeadings();
    return;
  }
  reportEls.tocList.innerHTML = toc
    .map(
      (item) => `
        <a class="toc-link level-${item.level}" href="#${escapeAttr(item.id)}" data-target="${escapeAttr(item.id)}">
          ${escapeHTML(item.text)}
        </a>
      `,
    )
    .join("");
  setActiveTocLink(toc[0].id);
  observeActiveHeadings();
}

function observeActiveHeadings() {
  if (reportState.headingObserver) {
    reportState.headingObserver.disconnect();
    reportState.headingObserver = null;
  }
  const activeView = reportState.view === "brief" ? reportEls.briefContent : reportEls.rawContent;
  const headings = Array.from(activeView.querySelectorAll("h1[id], h2[id], h3[id]"));
  if (!headings.length || !("IntersectionObserver" in window)) return;
  reportState.headingObserver = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      setActiveTocLink(visible.target.id);
    },
    { rootMargin: "-18% 0px -72% 0px", threshold: 0 },
  );
  headings.forEach((heading) => reportState.headingObserver.observe(heading));
}

function setActiveTocLink(id) {
  reportEls.tocList.querySelectorAll(".toc-link").forEach((link) => {
    link.classList.toggle("is-current", link.dataset.target === id);
  });
}

function compactToc(toc) {
  if (toc.length <= 48) return toc;
  return toc.filter((item) => item.level <= 2);
}

function handleReportSearchInput() {
  reportState.searchQuery = reportEls.searchInput.value.trim();
  clearTimeout(reportState.searchTimer);
  reportState.searchTimer = setTimeout(() => applyReportSearch(), 120);
}

function handleReportSearchKeydown(event) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  const hits = activeReportRoot().querySelectorAll(".report-search-hit");
  if (!hits.length) return;
  const current = Array.from(hits).findIndex((node) => node.classList.contains("is-current"));
  const next = hits[(current + 1 + hits.length) % hits.length];
  hits.forEach((node) => node.classList.remove("is-current"));
  next.classList.add("is-current");
  next.scrollIntoView({ behavior: "smooth", block: "center" });
}

function handleReportShortcut(event) {
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === "k") {
    event.preventDefault();
    reportEls.searchInput.focus();
    reportEls.searchInput.select();
    return;
  }
  if (event.key === "Escape" && document.activeElement === reportEls.searchInput) {
    reportEls.searchInput.value = "";
    reportState.searchQuery = "";
    applyReportSearch({ scroll: false });
  }
}

function updateBackToTopVisibility() {
  reportEls.backToTop.classList.toggle("is-visible", window.scrollY > 520);
}

function applyReportSearch(options = {}) {
  const { scroll = true } = options;
  const root = activeReportRoot();
  clearSearchHighlights(root);
  const query = reportState.searchQuery;
  if (!query) {
    reportEls.searchCount.textContent = "";
    return;
  }
  if (query.length < 2) {
    reportEls.searchCount.textContent = "至少 2 个字";
    return;
  }
  const count = highlightText(root, query);
  reportEls.searchCount.textContent = count ? `${count} 处匹配` : "无匹配";
  if (!count || !scroll) return;
  const first = root.querySelector(".report-search-hit");
  first?.classList.add("is-current");
  first?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function activeReportRoot() {
  return reportState.view === "brief" ? reportEls.briefContent : reportEls.rawContent;
}

function clearSearchHighlights(root) {
  root.querySelectorAll("mark.report-search-hit").forEach((mark) => {
    mark.replaceWith(document.createTextNode(mark.textContent || ""));
  });
  root.normalize();
}

function highlightText(root, query) {
  const matcher = new RegExp(escapeRegExp(query), "gi");
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !node.nodeValue || !matcher.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
      matcher.lastIndex = 0;
      if (["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "BUTTON"].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.closest("mark.report-search-hit")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  let count = 0;
  nodes.forEach((node) => {
    const value = node.nodeValue || "";
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    matcher.lastIndex = 0;
    value.replace(matcher, (match, offset) => {
      if (offset > lastIndex) fragment.appendChild(document.createTextNode(value.slice(lastIndex, offset)));
      const mark = document.createElement("mark");
      mark.className = "report-search-hit";
      mark.textContent = match;
      fragment.appendChild(mark);
      lastIndex = offset + match.length;
      count += 1;
      return match;
    });
    if (lastIndex < value.length) fragment.appendChild(document.createTextNode(value.slice(lastIndex)));
    node.replaceWith(fragment);
  });
  return count;
}

async function copyReportLink() {
  const text = window.location.href;
  try {
    await navigator.clipboard.writeText(text);
    setCopyLinkText("已复制");
  } catch {
    window.prompt("复制报告链接", text);
    setCopyLinkText("可手动复制");
  }
}

function setCopyLinkText(text) {
  reportEls.copyLink.textContent = text;
  setTimeout(() => {
    reportEls.copyLink.textContent = "复制链接";
  }, 1600);
}

function renderErrorState(title, message) {
  return `
    <div class="empty-state error-state">
      <strong>${escapeHTML(title)}</strong>
      <p>${escapeHTML(message || "当前内容不可用。")}</p>
      <a class="back-link" href="/">返回首页</a>
    </div>
  `;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const payload = await response.json();
      message = payload.error || message;
    } catch {
      // Keep response status text.
    }
    throw new Error(message);
  }
  return response.json();
}

function renderMarkdown(text) {
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

function collectTocFromElement(root) {
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function statusText(status) {
  return { running: "分析中", complete: "已完成", error: "失败" }[status] || "待开始";
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
