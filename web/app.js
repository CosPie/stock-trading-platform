const state = {
  depth: "shallow",
  activeReportId: null,
  settings: null,
  eventSource: null,
  completedStages: new Set(),
  activeReport: null,
  viewMode: "idle",
};

const els = {
  mainPanel: document.getElementById("mainPanel"),
  analysisWorkspace: document.getElementById("analysisWorkspace"),
  newAnalysisButton: document.getElementById("newAnalysisButton"),
  historySearch: document.getElementById("historySearch"),
  historyList: document.getElementById("historyList"),
  historyCount: document.getElementById("historyCount"),
  activeTickerTitle: document.getElementById("activeTickerTitle"),
  tickerInput: document.getElementById("tickerInput"),
  startButton: document.getElementById("startButton"),
  retryButton: document.getElementById("retryButton"),
  currentJobText: document.getElementById("currentJobText"),
  jobStatus: document.getElementById("jobStatus"),
  logList: document.getElementById("logList"),
  errorList: document.getElementById("errorList"),
  errorCount: document.getElementById("errorCount"),
  reportActions: document.getElementById("reportActions"),
  openReportPageButton: document.getElementById("openReportPageButton"),
  generateBriefButton: document.getElementById("generateBriefButton"),
  briefStatus: document.getElementById("briefStatus"),
  reportSubhead: document.getElementById("reportSubhead"),
  modelChip: document.getElementById("modelChip"),
  settingsButton: document.getElementById("settingsButton"),
  settingsModal: document.getElementById("settingsModal"),
  closeSettings: document.getElementById("closeSettings"),
  cancelSettings: document.getElementById("cancelSettings"),
  settingsForm: document.getElementById("settingsForm"),
  settingsMessage: document.getElementById("settingsMessage"),
  settingsPanelTitle: document.getElementById("settingsPanelTitle"),
  settingsPanelHint: document.getElementById("settingsPanelHint"),
};

const fields = {
  provider: document.getElementById("providerInput"),
  quickModel: document.getElementById("quickModelInput"),
  deepModel: document.getElementById("deepModelInput"),
  temperature: document.getElementById("temperatureInput"),
  apiKey: document.getElementById("apiKeyInput"),
  pythonPath: document.getElementById("pythonPathInput"),
  tradingAgentsDir: document.getElementById("tradingAgentsDirInput"),
  resultsDir: document.getElementById("resultsDirInput"),
  largeText: document.getElementById("largeTextInput"),
};

const tabCopy = {
  llm: ["LLM 模型", "配置 DeepSeek 模型，保存后下一次分析生效。"],
  api: ["API Key", "可信内网环境中保存 DeepSeek API Key。"],
  runtime: ["运行路径", "设置 Python 环境和 TradingAgents 子模块目录。"],
  ui: ["界面偏好", "调整字体和阅读体验。"],
};

init();

function init() {
  bindEvents();
  loadSettings();
  loadReports();
  setAnalysisView("idle");
}

function bindEvents() {
  document.querySelectorAll(".depth-option").forEach((button) => {
    button.addEventListener("click", () => setDepth(button.dataset.depth));
  });

  document.querySelectorAll(".settings-tab").forEach((button) => {
    button.addEventListener("click", () => setSettingsTab(button.dataset.tab));
  });

  document.querySelectorAll(".progress-tab").forEach((button) => {
    button.addEventListener("click", () => setLogTab(button.dataset.logTab));
  });

  els.newAnalysisButton.addEventListener("click", startNewAnalysis);

  els.historySearch.addEventListener("input", debounce(loadReports, 220));
  els.tickerInput.addEventListener("input", markManualAnalysis);
  els.startButton.addEventListener("click", startAnalysis);
  els.retryButton.addEventListener("click", startAnalysis);
  els.openReportPageButton.addEventListener("click", openSelectedReportPage);
  els.generateBriefButton.addEventListener("click", generateSelectedBrief);
  els.settingsButton.addEventListener("click", openSettings);
  els.closeSettings.addEventListener("click", closeSettings);
  els.cancelSettings.addEventListener("click", closeSettings);
  els.settingsModal.addEventListener("click", (event) => {
    if (event.target === els.settingsModal) closeSettings();
  });
  els.settingsForm.addEventListener("submit", saveSettings);
}

async function loadSettings() {
  const settings = await api("/api/settings");
  state.settings = settings;
  fillSettings(settings);
  updateModelChip();
}

function fillSettings(settings) {
  fields.provider.value = settings.llm.provider || "deepseek";
  fields.quickModel.value = settings.llm.quickModel || "deepseek-v4-flash";
  fields.deepModel.value = settings.llm.deepModel || "deepseek-v4-pro";
  fields.temperature.value = settings.llm.temperature || "";
  fields.apiKey.value = settings.llm.apiKey || "";
  fields.pythonPath.value = settings.runtime.pythonPath || "python3";
  fields.tradingAgentsDir.value = settings.runtime.tradingAgentsDir || "";
  fields.resultsDir.value = settings.runtime.resultsDir || "";
  fields.largeText.checked = Boolean(settings.interface.largeText);
  document.body.classList.toggle("large-text", fields.largeText.checked);
}

async function saveSettings(event) {
  event.preventDefault();
  const temperature = fields.temperature.value.trim();
  const settings = {
    llm: {
      provider: "deepseek",
      apiKey: fields.apiKey.value.trim(),
      quickModel: fields.quickModel.value,
      deepModel: fields.deepModel.value,
      backendUrl: state.settings?.llm?.backendUrl || "https://api.deepseek.com",
      temperature: temperature || null,
    },
    runtime: {
      pythonPath: fields.pythonPath.value.trim() || "python3",
      tradingAgentsDir: fields.tradingAgentsDir.value.trim(),
      resultsDir: fields.resultsDir.value.trim(),
    },
    interface: {
      largeText: fields.largeText.checked,
    },
  };
  const saved = await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
  state.settings = saved;
  fillSettings(saved);
  updateModelChip();
  els.settingsMessage.textContent = "已保存";
  setTimeout(() => (els.settingsMessage.textContent = ""), 1800);
}

async function loadReports() {
  const q = encodeURIComponent(els.historySearch.value.trim());
  const reports = await api(`/api/reports?q=${q}`);
  els.historyCount.textContent = reports.length;
  if (!reports.length) {
    els.historyList.innerHTML = '<div class="empty-state">暂无历史报告。</div>';
    return;
  }
  els.historyList.innerHTML = reports
    .map(
      (report) => `
        <div class="history-row ${report.id === state.activeReportId ? "is-active" : ""}">
          <button class="history-item" data-id="${escapeAttr(report.id)}" type="button">
            <strong>${escapeHTML(report.ticker)}</strong>
            <span>${escapeHTML(report.analysisDate)} · ${escapeHTML(report.depth)} · ${statusText(report.status)}</span>
            ${report.status === "error" ? '<em>可重新分析</em>' : ""}
          </button>
          ${
            report.status === "running"
              ? ""
              : `<button class="history-delete" type="button" aria-label="删除 ${escapeAttr(report.ticker)} 报告" data-id="${escapeAttr(report.id)}" data-ticker="${escapeAttr(report.ticker)}" title="删除">×</button>`
          }
        </div>
      `,
    )
    .join("");
  els.historyList.querySelectorAll(".history-item").forEach((button) => {
    button.addEventListener("click", () => openReport(button.dataset.id));
  });
  els.historyList.querySelectorAll(".history-delete").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteReport(button.dataset.id, button.dataset.ticker);
    });
  });
}

async function deleteReport(id, ticker) {
  const label = ticker || state.activeReport?.ticker || id;
  if (!window.confirm(`确定删除 ${label} 的历史报告吗？此操作不可恢复。`)) {
    return;
  }
  try {
    await api(`/api/reports/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (state.activeReportId === id) {
      clearActiveReport();
    }
    await loadReports();
  } catch (error) {
    window.alert(error.message);
  }
}

function clearActiveReport() {
  state.activeReportId = null;
  state.activeReport = null;
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  els.tickerInput.value = "";
  updateActiveTickerTitle("");
  els.currentJobText.textContent = "尚未开始分析";
  els.jobStatus.textContent = "待开始";
  els.reportSubhead.textContent = "选择左侧历史报告，或完成一次新分析后查看。";
  updateReportActions(null);
  renderLogs([]);
  syncStagesFromLogs([]);
  updateStartButton();
  updateRetryButton();
  setAnalysisView("idle");
}

function updateActiveTickerTitle(ticker) {
  const value = String(ticker || "").trim().toUpperCase();
  els.activeTickerTitle.textContent = value;
  els.activeTickerTitle.hidden = !value;
}

function updateRetryButton() {
  const showRetry = state.viewMode === "active" && state.activeReport && state.activeReport.status === "error";
  els.retryButton.hidden = !showRetry;
}

function startNewAnalysis() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  state.activeReportId = null;
  state.activeReport = null;
  els.tickerInput.value = "";
  setDepth("shallow", { keepRetry: true });
  els.currentJobText.textContent = "尚未开始分析";
  els.jobStatus.textContent = "待开始";
  els.reportSubhead.textContent = "选择左侧历史报告，或完成一次新分析后查看。";
  updateReportActions(null);
  renderLogs([]);
  syncStagesFromLogs([]);
  updateStartButton();
  els.startButton.disabled = false;
  updateActiveTickerTitle("");
  updateRetryButton();
  setAnalysisView("idle");
  els.tickerInput.focus();
  loadReports();
}

function setAnalysisView(mode) {
  state.viewMode = mode;
  const idle = mode === "idle";
  els.mainPanel.classList.toggle("is-idle", idle);
  els.mainPanel.classList.toggle("is-active", !idle);
  if (idle) {
    els.analysisWorkspace.hidden = true;
    els.analysisWorkspace.classList.remove("is-visible");
    updateActiveTickerTitle("");
    updateRetryButton();
    return;
  }
  els.analysisWorkspace.hidden = false;
  if (!els.analysisWorkspace.classList.contains("is-visible")) {
    void els.analysisWorkspace.offsetWidth;
    els.analysisWorkspace.classList.add("is-visible");
  }
  updateRetryButton();
}

async function openReport(id) {
  const report = await api(`/api/reports/${encodeURIComponent(id)}`);
  state.activeReportId = id;
  state.activeReport = report;
  els.tickerInput.value = report.ticker;
  updateActiveTickerTitle(report.ticker);
  setDepth(depthKey(report.depth), { keepRetry: true });
  updateStartButton();
  updateRetryButton();
  els.reportSubhead.textContent = `${report.ticker} · ${report.analysisDate} · ${report.depth}`;
  updateReportActions(report);
  renderLogs(report.logs || []);
  syncStagesFromLogs(report.logs || []);
  els.currentJobText.textContent = `${report.ticker} 历史报告`;
  els.jobStatus.textContent = statusText(report.status);
  setAnalysisView("active");
  loadReports();
}

async function startAnalysis() {
  const ticker = els.tickerInput.value.trim().toUpperCase();
  if (!ticker) {
    els.tickerInput.focus();
    return;
  }
  updateActiveTickerTitle(ticker);
  setAnalysisView("active");
  els.startButton.disabled = true;
  els.retryButton.hidden = true;
  resetRunUI();
  try {
    const retrying = state.activeReport && state.activeReport.status === "error";
    const report = await api("/api/analyses", {
      method: "POST",
      body: JSON.stringify({
        ticker,
        depth: state.depth,
        reportId: retrying ? state.activeReport.id : "",
      }),
    });
    state.activeReportId = report.id;
    state.activeReport = report;
    els.currentJobText.textContent = `${report.ticker} 正在分析`;
    els.jobStatus.textContent = "分析中";
    connectEvents(report.id);
    loadReports();
  } catch (error) {
    addLog({ stage: "启动失败", message: error.message, at: new Date().toISOString(), type: "error" });
    els.jobStatus.textContent = "失败";
    els.startButton.disabled = false;
    updateStartButton();
    updateRetryButton();
  }
}

function connectEvents(id) {
  if (state.eventSource) state.eventSource.close();
  state.eventSource = new EventSource(`/api/analyses/${encodeURIComponent(id)}/events`);
  ["queued", "start", "stage", "log", "complete", "error"].forEach((name) => {
    state.eventSource.addEventListener(name, (event) => handleEvent(JSON.parse(event.data)));
  });
  state.eventSource.onerror = () => {
    addLog({ stage: "连接", message: "实时连接中断，浏览器会自动重试。", at: new Date().toISOString() });
  };
}

async function handleEvent(event) {
  addLog(event);
  if (event.stage) markStage(event.stage, event.type === "stage" || event.type === "complete");
  if (event.type === "complete") {
    els.jobStatus.textContent = "已完成";
    els.startButton.disabled = false;
    updateStartButton();
    if (state.eventSource) state.eventSource.close();
    await openReport(event.jobId || state.activeReportId);
  }
  if (event.type === "error") {
    els.jobStatus.textContent = "失败";
    els.startButton.disabled = false;
    if (state.activeReport) state.activeReport.status = "error";
    updateStartButton();
    updateRetryButton();
    if (state.eventSource) state.eventSource.close();
    loadReports();
  }
}

function resetRunUI() {
  state.completedStages = new Set();
  document.querySelectorAll(".stage-line li").forEach((item) => {
    item.classList.remove("is-current", "is-done");
  });
  els.logList.innerHTML = "";
  els.errorList.innerHTML = "";
  els.errorCount.textContent = "0";
  setLogTab("logs");
  updateReportActions(null, "分析完成后可以打开报告页查看。");
  els.reportSubhead.textContent = "正在等待分析结果。";
}

function renderLogs(logs) {
  els.logList.innerHTML = "";
  els.errorList.innerHTML = "";
  els.errorCount.textContent = "0";
  let normalCount = 0;
  let errorCount = 0;
  logs.forEach((event) => {
    if (isErrorEvent(event)) {
      errorCount += 1;
      addLog(event, { target: "errors" });
      return;
    }
    normalCount += 1;
    addLog(event, { target: "logs" });
  });
  if (!normalCount) els.logList.innerHTML = '<div class="empty-state">暂无运行日志。</div>';
  if (!errorCount) els.errorList.innerHTML = '<div class="empty-state">暂无错误详情。</div>';
  els.errorCount.textContent = String(errorCount);
}

function addLog(event, options = {}) {
  const target = options.target || (isErrorEvent(event) ? "errors" : "logs");
  const list = target === "errors" ? els.errorList : els.logList;
  if (list.querySelector(".empty-state")) list.innerHTML = "";
  const payloadError = event.payload && event.payload.error ? `（${event.payload.error}）` : "";
  const message = `${event.message || ""}${payloadError}`;
  const row = document.createElement("div");
  if (target === "errors") {
    row.className = "error-row";
    row.innerHTML = `
      <div class="error-row-meta">
        <time>${formatTime(event.at)}</time>
        <strong>${escapeHTML(event.stage || event.type || "错误")}</strong>
      </div>
      <pre>${escapeHTML(message)}</pre>
    `;
  } else {
    row.className = "log-row";
    row.innerHTML = `
      <time>${formatTime(event.at)}</time>
      <strong>${escapeHTML(event.stage || event.type || "日志")}</strong>
      <span>${escapeHTML(message)}</span>
    `;
  }
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
  if (target === "errors") {
    els.errorCount.textContent = String(Number(els.errorCount.textContent || "0") + 1);
  }
}

function isErrorEvent(event) {
  const text = `${event.stage || ""} ${event.message || ""}`.toLowerCase();
  return (
    event.type === "error" ||
    event.stage === "系统输出" ||
    text.includes("failed") ||
    text.includes("traceback") ||
    text.includes("exception") ||
    text.includes("error:")
  );
}

function setLogTab(tab) {
  document.querySelectorAll(".progress-tab").forEach((button) => {
    const active = button.dataset.logTab === tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll("[data-log-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.logPanel !== tab;
  });
}

function syncStagesFromLogs(logs) {
  state.completedStages = new Set();
  document.querySelectorAll(".stage-line li").forEach((item) => item.classList.remove("is-current", "is-done"));
  logs.forEach((event) => {
    if (event.stage) markStage(event.stage, event.type === "stage" || event.type === "complete", false);
  });
}

function markStage(stage, done = true, current = true) {
  const item = document.querySelector(`.stage-line li[data-stage="${CSS.escape(stage)}"]`);
  if (!item) return;
  if (done) {
    item.classList.add("is-done");
    item.classList.remove("is-current");
    state.completedStages.add(stage);
  } else if (current) {
    item.classList.add("is-current");
  }
}

function setDepth(depth, options = {}) {
  state.depth = depth;
  document.querySelectorAll(".depth-option").forEach((button) => {
    const active = button.dataset.depth === depth;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-checked", String(active));
  });
  if (!options.keepRetry) {
    markManualAnalysis();
  }
}

function markManualAnalysis() {
  if (state.activeReport) {
    state.activeReport = null;
    state.activeReportId = null;
  }
  updateStartButton();
}

function updateStartButton() {
  const retrying = state.activeReport && state.activeReport.status === "error";
  els.startButton.textContent = retrying ? "重新分析" : "开始分析";
}

function depthKey(depth) {
  const value = String(depth || "").toLowerCase();
  if (value === "中度" || value === "medium") return "medium";
  if (value === "深度" || value === "deep" || value === "depth") return "deep";
  return "shallow";
}

function updateReportActions(report, hint = "") {
  const selected = Boolean(report);
  els.reportActions.classList.toggle("is-empty", !selected);
  els.openReportPageButton.disabled = !selected || (!report.reportMarkdown && !report.error && !report.summary);
  els.generateBriefButton.disabled = !selected || report.status !== "complete" || !report.reportMarkdown;
  els.reportActions.querySelector("p").textContent = selected
    ? `${report.ticker} 的报告已选择。${report.status === "complete" ? "可以打开新页面阅读。" : "当前报告未完成或失败。"}`
    : "暂无已选择报告。";
  if (!selected) {
    els.briefStatus.textContent = hint;
    return;
  }
  if (report.briefHtml) {
    els.briefStatus.textContent = "已生成分析简报。";
    els.generateBriefButton.textContent = "查看分析简报";
    els.generateBriefButton.disabled = false;
  } else if (report.status === "complete") {
    els.briefStatus.textContent = "可生成更容易阅读的 HTML 分析简报。";
    els.generateBriefButton.textContent = "生成分析简报";
  } else {
    els.briefStatus.textContent = report.error || "报告完成后可以生成简报。";
    els.generateBriefButton.textContent = "生成分析简报";
  }
}

function openSelectedReportPage() {
  if (!state.activeReportId) return;
  window.location.href = `/report/${encodeURIComponent(state.activeReportId)}`;
}

async function generateSelectedBrief() {
  if (!state.activeReportId) return;
  if (state.activeReport && state.activeReport.briefHtml) {
    window.location.href = `/report/${encodeURIComponent(state.activeReport.id)}?view=brief`;
    return;
  }
  els.generateBriefButton.disabled = true;
  els.generateBriefButton.textContent = "生成中...";
  els.briefStatus.textContent = "正在调用 LLM 生成分析简报，可能需要一两分钟。";
  try {
    const report = await api(`/api/reports/${encodeURIComponent(state.activeReportId)}/brief`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    state.activeReport = report;
    updateReportActions(report);
    window.location.href = `/report/${encodeURIComponent(report.id)}?view=brief`;
  } catch (error) {
    updateReportActions(state.activeReport);
    els.briefStatus.textContent = error.message;
  }
}

function openSettings() {
  els.settingsModal.hidden = false;
  setSettingsTab("llm");
}

function closeSettings() {
  els.settingsModal.hidden = true;
}

function setSettingsTab(tab) {
  document.querySelectorAll(".settings-tab").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tab === tab);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.panel === tab);
  });
  els.settingsPanelTitle.textContent = tabCopy[tab][0];
  els.settingsPanelHint.textContent = tabCopy[tab][1];
}

function updateModelChip() {
  const deep = state.settings?.llm?.deepModel || "deepseek-v4-pro";
  els.modelChip.textContent = `DeepSeek · ${deep}`;
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

function isMarkdownTable(lines, index) {
  const current = lines[index] || "";
  const next = lines[index + 1] || "";
  return current.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next);
}

function renderTable(rows) {
  const parsed = rows
    .filter((row, index) => index !== 1)
    .map((row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()));
  if (!parsed.length) return "";
  const [head, ...body] = parsed;
  return `<div class="markdown-table-wrap"><table><thead><tr>${head.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${body
    .map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

function inlineMarkdown(value) {
  return escapeHTML(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function formatTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
