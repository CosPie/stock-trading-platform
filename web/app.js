const state = {
  depth: "shallow",
  activeReportId: null,
  settings: null,
  eventSource: null,
  completedStages: new Set(),
  activeReport: null,
  viewMode: "idle",
  reports: [],
  statusFilter: "all",
  queue: [],
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
  tickerInputHint: document.getElementById("tickerInputHint"),
  tickerPreview: document.getElementById("tickerPreview"),
  startButton: document.getElementById("startButton"),
  clearTickersButton: document.getElementById("clearTickersButton"),
  retryButton: document.getElementById("retryButton"),
  currentJobText: document.getElementById("currentJobText"),
  jobStatus: document.getElementById("jobStatus"),
  queueList: document.getElementById("queueList"),
  queueSubhead: document.getElementById("queueSubhead"),
  logList: document.getElementById("logList"),
  errorList: document.getElementById("errorList"),
  errorCount: document.getElementById("errorCount"),
  reportMetrics: document.getElementById("reportMetrics"),
  comparisonTable: document.getElementById("comparisonTable"),
  comparisonSubhead: document.getElementById("comparisonSubhead"),
  reportActions: document.getElementById("reportActions"),
  selectedReportPreview: document.getElementById("selectedReportPreview"),
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
  updateTickerPreview();
  setAnalysisView("idle");
  setInterval(refreshRunningReports, 8000);
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

  document.querySelectorAll("[data-status-filter]").forEach((button) => {
    button.addEventListener("click", () => setStatusFilter(button.dataset.statusFilter));
  });

  document.querySelectorAll("[data-example-tickers]").forEach((button) => {
    button.addEventListener("click", () => useTickerExample(button.dataset.exampleTickers));
  });

  els.newAnalysisButton.addEventListener("click", startNewAnalysis);
  els.historySearch.addEventListener("input", debounce(loadReports, 220));
  els.tickerInput.addEventListener("input", markManualAnalysis);
  els.tickerInput.addEventListener("keydown", handleTickerKeydown);
  els.clearTickersButton.addEventListener("click", clearTickerInput);
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
  try {
    const settings = await api("/api/settings");
    state.settings = settings;
    fillSettings(settings);
    updateModelChip();
  } catch (error) {
    els.modelChip.textContent = "设置加载失败";
    console.error(error);
  }
}

function fillSettings(settings) {
  fields.provider.value = settings.llm.provider || "deepseek";
  fields.quickModel.value = settings.llm.quickModel || "deepseek-v4-flash";
  fields.deepModel.value = settings.llm.deepModel || "deepseek-v4-pro";
  fields.temperature.value = settings.llm.temperature || "";
  fields.apiKey.value = "";
  fields.apiKey.placeholder = settings.llm.apiKey ? "已保存，留空则保持当前 Key" : "sk-...";
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
      apiKey: fields.apiKey.value.trim() || state.settings?.llm?.apiKey || "",
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
  try {
    const q = encodeURIComponent(els.historySearch.value.trim());
    const reports = await api(`/api/reports?q=${q}`);
    state.reports = reports;
    renderHistory();
    renderOverview();
    renderComparison();
    renderQueue();
  } catch (error) {
    els.historyList.innerHTML = `<div class="empty-state error-state"><strong>历史报告加载失败</strong><p>${escapeHTML(error.message)}</p></div>`;
    els.comparisonTable.innerHTML = `<div class="empty-state error-state"><strong>报告对比暂不可用</strong><p>${escapeHTML(error.message)}</p></div>`;
    els.queueList.innerHTML = '<div class="empty-state">暂无运行中的分析队列。</div>';
    els.reportMetrics.innerHTML = "";
  }
}

function refreshRunningReports() {
  const hasRunning = state.reports.some((report) => report.status === "running") || state.queue.some((item) => item.status === "queued" || item.status === "running");
  if (hasRunning) {
    loadReports();
  }
}

function renderHistory() {
  const reports = filteredReports();
  els.historyCount.textContent = state.reports.length;
  if (!reports.length) {
    els.historyList.innerHTML = '<div class="empty-state compact">没有匹配的历史报告。</div>';
    return;
  }
  els.historyList.innerHTML = reports
    .map((report) => {
      const selected = report.id === state.activeReportId ? "is-active" : "";
      const status = report.status || "pending";
      return `
        <div class="history-row ${selected}">
          <button class="history-item" data-id="${escapeAttr(report.id)}" type="button">
            <span class="history-head">
              <strong>${escapeHTML(report.ticker)}</strong>
              <span class="mini-status is-${escapeAttr(status)}">${statusText(status)}</span>
            </span>
            <span>${escapeHTML(report.analysisDate)} · ${escapeHTML(report.depth)} · ${durationText(report.durationSeconds)}</span>
            <span>${escapeHTML(decisionText(report.decision))}</span>
            ${report.status === "error" ? '<em>可重新分析</em>' : ""}
          </button>
          ${
            report.status === "running"
              ? ""
              : `<button class="history-delete" type="button" aria-label="删除 ${escapeAttr(report.ticker)} 报告" data-id="${escapeAttr(report.id)}" data-ticker="${escapeAttr(report.ticker)}" title="删除">×</button>`
          }
        </div>
      `;
    })
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

function filteredReports() {
  if (state.statusFilter === "all") return state.reports;
  return state.reports.filter((report) => report.status === state.statusFilter);
}

function setStatusFilter(filter) {
  state.statusFilter = filter || "all";
  document.querySelectorAll("[data-status-filter]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.statusFilter === state.statusFilter);
  });
  renderHistory();
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
  closeEventSource();
  els.tickerInput.value = "";
  updateTickerPreview();
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
  els.activeTickerTitle.textContent = value ? `${value} 分析` : "";
  els.activeTickerTitle.hidden = !value;
}

function updateRetryButton() {
  const showRetry = state.viewMode === "active" && state.activeReport && state.activeReport.status === "error";
  els.retryButton.hidden = !showRetry;
}

function startNewAnalysis() {
  state.activeReportId = null;
  state.activeReport = null;
  closeEventSource();
  els.tickerInput.value = "";
  updateTickerPreview();
  setDepth("shallow", { keepRetry: true });
  els.currentJobText.textContent = "尚未开始分析";
  els.jobStatus.textContent = "待开始";
  els.reportSubhead.textContent = "选择左侧历史报告，或完成一次新分析后查看。";
  updateReportActions(null);
  renderLogs([]);
  syncStagesFromLogs([]);
  updateStartButton();
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
  let report;
  try {
    report = await api(`/api/reports/${encodeURIComponent(id)}`);
  } catch (error) {
    els.reportSubhead.textContent = "报告加载失败";
    updateReportActions(null, error.message);
    window.alert(error.message);
    return;
  }
  state.activeReportId = id;
  state.activeReport = report;
  els.tickerInput.value = report.ticker;
  updateTickerPreview();
  updateActiveTickerTitle(report.ticker);
  setDepth(depthKey(report.depth), { keepRetry: true });
  updateStartButton();
  updateRetryButton();
  els.reportSubhead.textContent = `${report.ticker} · ${report.analysisDate} · ${report.depth}`;
  updateReportActions(report);
  renderLogs(report.logs || []);
  syncStagesFromLogs(report.logs || []);
  els.currentJobText.textContent = `${report.ticker} ${report.status === "running" ? "正在分析" : "历史报告"}`;
  els.jobStatus.textContent = statusText(report.status);
  setAnalysisView("active");
  if (report.status === "running") {
    connectEvents(report.id);
  } else {
    closeEventSource();
  }
  loadReports();
}

async function startAnalysis() {
  const retrying = state.activeReport && state.activeReport.status === "error";
  const tickers = retrying ? [state.activeReport.ticker] : parseTickers();
  if (!tickers.length) {
    els.tickerInput.focus();
    return;
  }

  setAnalysisView("active");
  els.startButton.disabled = true;
  els.retryButton.hidden = true;
  resetRunUI(tickers);

  const started = [];
  const failed = [];
  for (const ticker of tickers) {
    try {
      const report = await api("/api/analyses", {
        method: "POST",
        body: JSON.stringify({
          ticker,
          depth: state.depth,
          reportId: retrying ? state.activeReport.id : "",
        }),
      });
      started.push(report);
      upsertQueue(report);
    } catch (error) {
      failed.push({ ticker, error: error.message });
      upsertQueue({ ticker, status: "error", error: error.message });
    }
  }

  if (started.length) {
    const first = started[0];
    state.activeReportId = first.id;
    state.activeReport = first;
    updateActiveTickerTitle(started.length > 1 ? `${started.length} 个股票` : first.ticker);
    els.currentJobText.textContent =
      started.length > 1 ? `已启动 ${started.length} 个分析任务，正在跟踪 ${first.ticker}` : `${first.ticker} 正在分析`;
    els.jobStatus.textContent = failed.length ? "部分启动" : "分析中";
    connectEvents(first.id);
  } else {
    els.jobStatus.textContent = "启动失败";
    failed.forEach((item) => addLog({ stage: item.ticker, message: item.error, at: new Date().toISOString(), type: "error" }));
  }

  if (failed.length) {
    setLogTab("errors");
  }
  els.startButton.disabled = false;
  updateStartButton();
  renderQueue();
  loadReports();
}

function resetRunUI(tickers = []) {
  state.completedStages = new Set();
  state.queue = tickers.map((ticker) => ({ ticker, status: "queued" }));
  document.querySelectorAll(".stage-line li").forEach((item) => {
    item.classList.remove("is-current", "is-done");
  });
  els.logList.innerHTML = "";
  els.errorList.innerHTML = "";
  els.errorCount.textContent = "0";
  setLogTab("logs");
  updateReportActions(null, "分析完成后可以打开报告页查看。");
  els.reportSubhead.textContent = tickers.length > 1 ? "正在批量启动分析任务。" : "正在等待分析结果。";
  renderQueue();
}

function connectEvents(id) {
  closeEventSource();
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
    closeEventSource();
    await openReport(event.jobId || state.activeReportId);
  }
  if (event.type === "error") {
    els.jobStatus.textContent = "失败";
    els.startButton.disabled = false;
    if (state.activeReport) state.activeReport.status = "error";
    updateStartButton();
    updateRetryButton();
    closeEventSource();
    loadReports();
  }
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
    if (message.length > 220 || message.includes("\n")) {
      row.classList.add("is-long");
    }
    row.innerHTML = `
      <div class="log-row-meta">
        <time>${formatTime(event.at)}</time>
        <strong>${escapeHTML(event.stage || event.type || "日志")}</strong>
      </div>
      <pre class="log-message">${escapeHTML(message)}</pre>
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
    panel.hidden = panel.datasetLogPanel !== tab && panel.dataset.logPanel !== tab;
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
  updateTickerPreview();
  if (state.activeReport) {
    state.activeReport = null;
    state.activeReportId = null;
  }
  updateStartButton();
}

function updateStartButton() {
  const retrying = state.activeReport && state.activeReport.status === "error";
  const count = parseTickers().length;
  if (retrying) {
    els.startButton.textContent = "重新分析";
    els.startButton.disabled = false;
    els.tickerInputHint.textContent = "上次分析失败，可以直接重新分析。";
    return;
  }
  els.startButton.textContent = count > 1 ? `开始分析 ${count} 个` : "开始分析";
  els.startButton.disabled = count === 0;
  els.tickerInputHint.textContent = count
    ? `已识别 ${count} 个股票。按 Enter 开始，Shift+Enter 换行。`
    : "按 Enter 开始分析，Shift+Enter 换行。";
}

function clearTickerInput() {
  els.tickerInput.value = "";
  markManualAnalysis();
  els.tickerInput.focus();
}

function useTickerExample(value) {
  els.tickerInput.value = value || "";
  markManualAnalysis();
  els.tickerInput.focus();
}

function handleTickerKeydown(event) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  if (els.startButton.disabled) {
    els.tickerInputHint.textContent = "先输入一个股票代码，例如 AAPL 或 MU。";
    els.tickerInput.focus();
    return;
  }
  startAnalysis();
}

function parseTickers() {
  const seen = new Set();
  const raw = els.tickerInput.value.toUpperCase().split(/[\s,，;；、]+/);
  return raw
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function updateTickerPreview() {
  const tickers = parseTickers();
  if (!tickers.length) {
    els.tickerPreview.innerHTML = "<span>待分析 0 个</span>";
    return;
  }
  els.tickerPreview.innerHTML = `
    <span>待分析 ${tickers.length} 个</span>
    ${tickers.map((ticker) => `<button class="ticker-token" type="button" data-ticker="${escapeAttr(ticker)}">${escapeHTML(ticker)}</button>`).join("")}
  `;
  els.tickerPreview.querySelectorAll(".ticker-token").forEach((button) => {
    button.addEventListener("click", () => removeTicker(button.dataset.ticker));
  });
}

function removeTicker(ticker) {
  const next = parseTickers().filter((item) => item !== ticker);
  els.tickerInput.value = next.join(", ");
  markManualAnalysis();
}

function upsertQueue(report) {
  const key = report.id || report.ticker;
  const found = state.queue.findIndex((item) => (item.id || item.ticker) === key || item.ticker === report.ticker);
  const next = { ...state.queue[found], ...report };
  if (found >= 0) {
    state.queue[found] = next;
  } else {
    state.queue.push(next);
  }
  renderQueue();
}

function renderQueue() {
  const queueReports = mergeQueueWithReports();
  if (!queueReports.length) {
    els.queueSubhead.textContent = "批量启动后会显示每个股票的任务状态。";
    els.queueList.innerHTML = '<div class="empty-state">暂无运行中的分析队列。</div>';
    return;
  }
  const running = queueReports.filter((item) => item.status === "running" || item.status === "queued").length;
  els.queueSubhead.textContent = `${queueReports.length} 个任务，${running} 个仍在推进。`;
  els.queueList.innerHTML = queueReports
    .map(
      (item) => `
        <button class="queue-item ${item.id === state.activeReportId ? "is-active" : ""}" type="button" data-id="${escapeAttr(item.id || "")}" ${item.id ? "" : "disabled"}>
          <span>
            <strong>${escapeHTML(item.ticker)}</strong>
            <small>${escapeHTML(item.analysisDate || "今日")} · ${escapeHTML(item.depth || depthText(state.depth))}</small>
          </span>
          <span class="mini-status is-${escapeAttr(item.status || "queued")}">${statusText(item.status || "queued")}</span>
        </button>
      `,
    )
    .join("");
  els.queueList.querySelectorAll(".queue-item[data-id]").forEach((button) => {
    if (button.dataset.id) button.addEventListener("click", () => openReport(button.dataset.id));
  });
}

function mergeQueueWithReports() {
  const queueTickers = new Set(state.queue.map((item) => item.ticker));
  const relatedReports = state.reports.filter((report) => queueTickers.has(report.ticker) || report.status === "running");
  const byTicker = new Map();
  [...state.queue, ...relatedReports].forEach((item) => {
    byTicker.set(item.ticker, { ...byTicker.get(item.ticker), ...item });
  });
  return Array.from(byTicker.values());
}

function renderOverview() {
  const total = state.reports.length;
  const complete = state.reports.filter((report) => report.status === "complete").length;
  const running = state.reports.filter((report) => report.status === "running").length;
  const error = state.reports.filter((report) => report.status === "error").length;
  const latest = state.reports[0];
  const values = [
    ["全部报告", total, latest ? `${latest.ticker} 最近更新` : "尚未生成报告"],
    ["已完成", complete, total ? `${Math.round((complete / total) * 100)}% 完成率` : "等待首次分析"],
    ["分析中", running, running ? "可从左侧切换跟踪" : "当前无运行任务"],
    ["需处理", error, error ? "失败任务可重新分析" : "暂无失败任务"],
  ];
  els.reportMetrics.innerHTML = values
    .map(
      ([label, value, hint]) => `
        <div class="metric-item">
          <span>${label}</span>
          <strong>${value}</strong>
          <small>${escapeHTML(hint)}</small>
        </div>
      `,
    )
    .join("");
}

function renderComparison() {
  const reports = state.reports.filter((report) => report.status === "complete").slice(0, 8);
  if (!reports.length) {
    els.comparisonSubhead.textContent = "完成分析后可在这里横向查看结论、耗时和简报状态。";
    els.comparisonTable.innerHTML = '<div class="empty-state">还没有可对比的完成报告。</div>';
    return;
  }
  els.comparisonSubhead.textContent = `展示最近 ${reports.length} 份完成报告。`;
  els.comparisonTable.innerHTML = `
    <table class="comparison-table">
      <thead>
        <tr>
          <th>股票</th>
          <th>日期</th>
          <th>深度</th>
          <th>决策</th>
          <th>耗时</th>
          <th>简报</th>
        </tr>
      </thead>
      <tbody>
        ${reports
          .map(
            (report) => `
              <tr>
                <td><button class="table-link" type="button" data-id="${escapeAttr(report.id)}">${escapeHTML(report.ticker)}</button></td>
                <td>${escapeHTML(report.analysisDate)}</td>
                <td>${escapeHTML(report.depth)}</td>
                <td>${escapeHTML(decisionText(report.decision))}</td>
                <td>${durationText(report.durationSeconds)}</td>
                <td>${report.briefHtml ? "已生成" : "未生成"}</td>
              </tr>
            `,
          )
          .join("")}
      </tbody>
    </table>
  `;
  els.comparisonTable.querySelectorAll(".table-link").forEach((button) => {
    button.addEventListener("click", () => openReport(button.dataset.id));
  });
}

function updateReportActions(report, hint = "") {
  const selected = Boolean(report);
  els.reportActions.classList.toggle("is-empty", !selected);
  els.openReportPageButton.disabled = !selected || (!report.reportMarkdown && !report.error && !report.summary);
  els.generateBriefButton.disabled = !selected || report.status !== "complete" || !report.reportMarkdown;
  els.reportActions.querySelector("p").textContent = selected
    ? `${report.ticker} 的报告已选择。${report.status === "complete" ? "可以打开新页面阅读。" : "当前报告未完成或失败。"}`
    : "暂无已选择报告。";
  els.selectedReportPreview.innerHTML = selected ? renderSelectedReportPreview(report) : "";
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

function renderSelectedReportPreview(report) {
  return `
    <dl>
      <div><dt>状态</dt><dd>${statusText(report.status)}</dd></div>
      <div><dt>决策</dt><dd>${escapeHTML(decisionText(report.decision))}</dd></div>
      <div><dt>耗时</dt><dd>${durationText(report.durationSeconds)}</dd></div>
      <div><dt>日志</dt><dd>${(report.logs || []).length} 条</dd></div>
    </dl>
    <p>${escapeHTML(report.summary || report.error || "暂无摘要，打开报告页查看完整输出。")}</p>
  `;
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

function depthKey(depth) {
  const value = String(depth || "").toLowerCase();
  if (value === "中度" || value === "medium") return "medium";
  if (value === "深度" || value === "deep" || value === "depth") return "deep";
  return "shallow";
}

function depthText(depth) {
  return { shallow: "浅度", medium: "中度", deep: "深度" }[depth] || "浅度";
}

function decisionText(decision) {
  const value = String(decision || "").trim();
  return value || "未提取";
}

function durationText(seconds) {
  const value = Number(seconds || 0);
  if (!value) return "未记录";
  if (value < 60) return `${value} 秒`;
  const mins = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${mins} 分 ${rest} 秒` : `${mins} 分`;
}

function closeEventSource() {
  if (!state.eventSource) return;
  state.eventSource.close();
  state.eventSource = null;
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

function formatTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function statusText(status) {
  return { queued: "待启动", running: "分析中", complete: "已完成", error: "失败" }[status] || "待开始";
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
