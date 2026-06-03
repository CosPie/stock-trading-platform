const reportState = {
  report: null,
  view: new URLSearchParams(window.location.search).get("view") || "brief",
};

const reportEls = {
  title: document.getElementById("reportTitle"),
  meta: document.getElementById("reportMeta"),
  generate: document.getElementById("generateBriefPageButton"),
  briefView: document.getElementById("briefView"),
  rawView: document.getElementById("rawView"),
  briefEmpty: document.getElementById("briefEmpty"),
  briefFrame: document.getElementById("briefFrame"),
  rawContent: document.getElementById("rawReportContent"),
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
  await loadReport();
  setReportView(reportState.view);
}

async function loadReport() {
  const report = await api(`/api/reports/${encodeURIComponent(reportID())}`);
  reportState.report = report;
  reportEls.title.textContent = `${report.ticker} 报告`;
  reportEls.meta.textContent = `${report.analysisDate} · ${report.depth} · ${statusText(report.status)}`;
  reportEls.rawContent.innerHTML = renderMarkdown(report.reportMarkdown || report.summary || report.error || "暂无报告内容。");
  renderBrief(report.briefHtml);
  reportEls.generate.disabled = Boolean(report.briefHtml) || report.status !== "complete" || !report.reportMarkdown;
  reportEls.generate.textContent = report.briefHtml ? "已生成分析简报" : "生成分析简报";
}

function renderBrief(html) {
  if (!html) {
    reportEls.briefEmpty.hidden = false;
    reportEls.briefFrame.hidden = true;
    return;
  }
  reportEls.briefEmpty.hidden = true;
  reportEls.briefFrame.hidden = false;
  reportEls.briefFrame.srcdoc = html;
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
    reportEls.generate.disabled = true;
    reportEls.generate.textContent = "已生成分析简报";
  } catch (error) {
    reportEls.briefEmpty.hidden = false;
    reportEls.briefFrame.hidden = true;
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
    html.push(`<${list.type}>${list.items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</${list.type}>`);
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
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      flushQuote();
      const level = Math.min(heading[1].length, 3);
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
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
  return html.join("");
}

function inlineMarkdown(value) {
  return escapeHTML(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
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
