<script>
  import { onDestroy, onMount, tick } from "svelte";
  import {
    AlertCircle,
    BarChart3,
    CheckCircle2,
    Clock3,
    FileText,
    History,
    Loader2,
    Play,
    Plus,
    Search,
    Settings,
    Trash2,
    X,
  } from "@lucide/svelte";
  import {
    api,
    decisionText,
    depthKey,
    depthText,
    durationText,
    formatTime,
    isErrorEvent,
    parseTickers,
    statusText,
  } from "./api";

  const stages = ["市场分析", "情绪分析", "新闻分析", "基本面分析", "研究团队", "交易员", "风控团队", "组合经理"];
  const examples = ["AAPL, MSFT, NVDA", "MU", "TSLA, AMD"];
  const depths = [
    { key: "shallow", title: "浅度", hint: "更快" },
    { key: "medium", title: "中度", hint: "更稳" },
    { key: "deep", title: "深度", hint: "更细" },
  ];
  const statusFilters = [
    ["all", "全部"],
    ["running", "分析中"],
    ["complete", "已完成"],
    ["error", "失败"],
  ];
  const settingsTabs = {
    llm: ["LLM 模型", "配置 DeepSeek 模型，保存后下一次分析生效。"],
    api: ["API Key", "可信内网环境中保存 DeepSeek API Key。"],
    runtime: ["运行路径", "设置 Python 环境和 TradingAgents 子模块目录。"],
    ui: ["界面偏好", "调整字体和阅读体验。"],
  };

  let depth = "shallow";
  let activeReportId = null;
  let activeReport = null;
  let settings = null;
  let eventSource = null;
  let completedStages = new Set();
  let currentStage = "";
  let viewMode = "idle";
  let reports = [];
  let statusFilter = "all";
  let queue = [];
  let tickerInput = "";
  let historySearch = "";
  let logTab = "logs";
  let logs = [];
  let errorLogs = [];
  let settingsOpen = false;
  let settingsTab = "llm";
  let settingsMessage = "";
  let briefStatus = "";
  let loadingReports = false;
  let launchError = "";
  let reportSubhead = "选择左侧历史报告，或完成一次新分析后查看。";
  let currentJobText = "尚未开始分析";
  let jobStatus = "待开始";
  let historyTimer;
  let refreshTimer;
  let logListNode;
  let errorListNode;

  let form = {
    provider: "deepseek",
    quickModel: "deepseek-v4-flash",
    deepModel: "deepseek-v4-pro",
    temperature: "",
    apiKey: "",
    pythonPath: "python3",
    tradingAgentsDir: "",
    resultsDir: "",
    largeText: true,
  };

  $: tickers = parseTickers(tickerInput);
  $: filteredReports = statusFilter === "all" ? reports : reports.filter((report) => report.status === statusFilter);
  $: runningReports = reports.filter((report) => report.status === "running").length;
  $: completeReports = reports.filter((report) => report.status === "complete").length;
  $: errorReports = reports.filter((report) => report.status === "error").length;
  $: latestReport = reports[0];
  $: comparisonReports = reports.filter((report) => report.status === "complete").slice(0, 8);
  $: queueReports = mergeQueueWithReports();
  $: modelChip = settings?.llm?.deepModel ? `DeepSeek · ${settings.llm.deepModel}` : "DeepSeek · deepseek-v4-pro";
  $: retrying = activeReport && activeReport.status === "error";
  $: canStart = retrying || tickers.length > 0;
  $: hasSelectedReport = Boolean(activeReport);
  $: showAnalysisEntry = !activeReport || activeReport.status !== "complete";
  $: showOverview = !activeReport || activeReport.status !== "complete";
  $: showQueue = !activeReport || activeReport.status !== "complete";
  $: activeTickerTitle = activeReport ? `${activeReport.ticker} 分析` : viewMode === "active" && queue.length > 1 ? `${queue.length} 个股票分析` : "";
  $: startButtonText = retrying ? "重新分析" : tickers.length > 1 ? `开始分析 ${tickers.length} 个` : "开始分析";
  $: inputHint = retrying
    ? "上次分析失败，可以直接重新分析。"
    : tickers.length
      ? `已识别 ${tickers.length} 个股票。按 Enter 开始，Shift+Enter 换行。`
      : "按 Enter 开始分析，Shift+Enter 换行。";

  onMount(() => {
    loadSettings();
    loadReports();
    refreshTimer = setInterval(refreshRunningReports, 8000);
  });

  onDestroy(() => {
    closeEventSource();
    clearInterval(refreshTimer);
    clearTimeout(historyTimer);
  });

  async function loadSettings() {
    try {
      settings = await api("/api/settings");
      fillSettings(settings);
    } catch (error) {
      settingsMessage = error.message;
    }
  }

  function fillSettings(value) {
    form = {
      provider: value.llm?.provider || "deepseek",
      quickModel: value.llm?.quickModel || "deepseek-v4-flash",
      deepModel: value.llm?.deepModel || "deepseek-v4-pro",
      temperature: value.llm?.temperature || "",
      apiKey: "",
      pythonPath: value.runtime?.pythonPath || "python3",
      tradingAgentsDir: value.runtime?.tradingAgentsDir || "",
      resultsDir: value.runtime?.resultsDir || "",
      largeText: Boolean(value.interface?.largeText),
    };
    document.body.classList.toggle("large-text", form.largeText);
  }

  async function saveSettings() {
    const payload = {
      llm: {
        provider: "deepseek",
        apiKey: form.apiKey.trim() || settings?.llm?.apiKey || "",
        quickModel: form.quickModel,
        deepModel: form.deepModel,
        backendUrl: settings?.llm?.backendUrl || "https://api.deepseek.com",
        temperature: String(form.temperature || "").trim() || null,
      },
      runtime: {
        pythonPath: form.pythonPath.trim() || "python3",
        tradingAgentsDir: form.tradingAgentsDir.trim(),
        resultsDir: form.resultsDir.trim(),
      },
      interface: {
        largeText: form.largeText,
      },
    };
    settings = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    fillSettings(settings);
    settingsMessage = "已保存";
    setTimeout(() => (settingsMessage = ""), 1800);
  }

  async function loadReports() {
    loadingReports = true;
    try {
      const q = encodeURIComponent(historySearch.trim());
      reports = await api(`/api/reports?q=${q}`);
      launchError = "";
    } catch (error) {
      launchError = error.message;
    } finally {
      loadingReports = false;
    }
  }

  function scheduleHistorySearch() {
    clearTimeout(historyTimer);
    historyTimer = setTimeout(loadReports, 220);
  }

  function refreshRunningReports() {
    const hasRunning = reports.some((report) => report.status === "running") || queue.some((item) => item.status === "queued" || item.status === "running");
    if (hasRunning) loadReports();
  }

  async function deleteReport(id, ticker) {
    const label = ticker || activeReport?.ticker || id;
    if (!window.confirm(`确定删除 ${label} 的历史报告吗？此操作不可恢复。`)) return;
    try {
      await api(`/api/reports/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (activeReportId === id) clearActiveReport();
      await loadReports();
    } catch (error) {
      window.alert(error.message);
    }
  }

  function clearActiveReport() {
    activeReportId = null;
    activeReport = null;
    closeEventSource();
    tickerInput = "";
    currentJobText = "尚未开始分析";
    jobStatus = "待开始";
    reportSubhead = "选择左侧历史报告，或完成一次新分析后查看。";
    briefStatus = "";
    logs = [];
    errorLogs = [];
    completedStages = new Set();
    currentStage = "";
    viewMode = "idle";
  }

  function startNewAnalysis() {
    activeReportId = null;
    activeReport = null;
    closeEventSource();
    tickerInput = "";
    depth = "shallow";
    currentJobText = "尚未开始分析";
    jobStatus = "待开始";
    reportSubhead = "选择左侧历史报告，或完成一次新分析后查看。";
    briefStatus = "";
    logs = [];
    errorLogs = [];
    completedStages = new Set();
    currentStage = "";
    viewMode = "idle";
    loadReports();
  }

  async function openReport(id) {
    let report;
    try {
      report = await api(`/api/reports/${encodeURIComponent(id)}`);
    } catch (error) {
      reportSubhead = "报告加载失败";
      briefStatus = error.message;
      window.alert(error.message);
      return;
    }
    activeReportId = id;
    activeReport = report;
    tickerInput = report.ticker;
    depth = depthKey(report.depth);
    reportSubhead = `${report.ticker} · ${report.analysisDate} · ${report.depth}`;
    setLogsFromReport(report.logs || []);
    currentJobText = `${report.ticker} ${report.status === "running" ? "正在分析" : "历史报告"}`;
    jobStatus = statusText(report.status);
    viewMode = "active";
    if (report.status === "running") {
      connectEvents(report.id);
    } else {
      closeEventSource();
    }
    await loadReports();
  }

  async function startAnalysis() {
    const launchTickers = retrying ? [activeReport.ticker] : tickers;
    if (!launchTickers.length) return;
    viewMode = "active";
    resetRunUI(launchTickers);

    const started = [];
    const failed = [];
    for (const ticker of launchTickers) {
      try {
        const report = await api("/api/analyses", {
          method: "POST",
          body: JSON.stringify({
            ticker,
            depth,
            reportId: retrying ? activeReport.id : "",
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
      activeReportId = first.id;
      activeReport = first;
      currentJobText = started.length > 1 ? `已启动 ${started.length} 个分析任务，正在跟踪 ${first.ticker}` : `${first.ticker} 正在分析`;
      jobStatus = failed.length ? "部分启动" : "分析中";
      connectEvents(first.id);
    } else {
      jobStatus = "启动失败";
      failed.forEach((item) => addLog({ stage: item.ticker, message: item.error, at: new Date().toISOString(), type: "error" }));
    }

    if (failed.length) logTab = "errors";
    await loadReports();
  }

  function resetRunUI(items = []) {
    completedStages = new Set();
    currentStage = "";
    queue = items.map((ticker) => ({ ticker, status: "queued" }));
    logs = [];
    errorLogs = [];
    logTab = "logs";
    reportSubhead = items.length > 1 ? "正在批量启动分析任务。" : "正在等待分析结果。";
    briefStatus = "分析完成后可以打开报告页查看。";
  }

  function connectEvents(id) {
    closeEventSource();
    eventSource = new EventSource(`/api/analyses/${encodeURIComponent(id)}/events`);
    ["queued", "start", "stage", "log", "complete", "error"].forEach((name) => {
      eventSource.addEventListener(name, (event) => handleEvent(JSON.parse(event.data)));
    });
    eventSource.onerror = () => {
      addLog({ stage: "连接", message: "实时连接中断，浏览器会自动重试。", at: new Date().toISOString() });
    };
  }

  async function handleEvent(event) {
    addLog(event);
    if (event.stage) markStage(event.stage, event.type === "stage" || event.type === "complete");
    if (event.type === "complete") {
      jobStatus = "已完成";
      closeEventSource();
      await openReport(event.jobId || activeReportId);
    }
    if (event.type === "error") {
      jobStatus = "失败";
      if (activeReport) activeReport = { ...activeReport, status: "error" };
      closeEventSource();
      await loadReports();
    }
  }

  function setLogsFromReport(items) {
    logs = [];
    errorLogs = [];
    completedStages = new Set();
    currentStage = "";
    items.forEach((event) => {
      addLog(event, { scroll: false });
      if (event.stage) markStage(event.stage, event.type === "stage" || event.type === "complete");
    });
  }

  async function addLog(event, options = {}) {
    const target = isErrorEvent(event) ? "errors" : "logs";
    if (target === "errors") errorLogs = [...errorLogs, event];
    else logs = [...logs, event];
    if (options.scroll === false) return;
    await tick();
    const node = target === "errors" ? errorListNode : logListNode;
    if (node) node.scrollTop = node.scrollHeight;
  }

  function markStage(stage, done = true) {
    currentStage = stage;
    if (!done) return;
    const next = new Set(completedStages);
    next.add(stage);
    completedStages = next;
  }

  function upsertQueue(report) {
    const key = report.id || report.ticker;
    const found = queue.findIndex((item) => (item.id || item.ticker) === key || item.ticker === report.ticker);
    const next = { ...(queue[found] || {}), ...report };
    queue = found >= 0 ? queue.map((item, index) => (index === found ? next : item)) : [...queue, next];
  }

  function mergeQueueWithReports() {
    const queueTickers = new Set(queue.map((item) => item.ticker));
    const relatedReports = reports.filter((report) => queueTickers.has(report.ticker) || report.status === "running");
    const byTicker = new Map();
    [...queue, ...relatedReports].forEach((item) => {
      byTicker.set(item.ticker, { ...byTicker.get(item.ticker), ...item });
    });
    return Array.from(byTicker.values());
  }

  function removeTicker(ticker) {
    tickerInput = tickers.filter((item) => item !== ticker).join(", ");
    activeReport = null;
    activeReportId = null;
  }

  function handleTickerKeydown(event) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (canStart) startAnalysis();
  }

  function openSelectedReportPage(view = "") {
    if (!activeReportId) return;
    window.location.href = `/report/${encodeURIComponent(activeReportId)}${view ? `?view=${view}` : ""}`;
  }

  async function generateSelectedBrief() {
    if (!activeReportId) return;
    if (activeReport?.briefHtml) {
      openSelectedReportPage("brief");
      return;
    }
    briefStatus = "正在调用 LLM 生成分析简报，可能需要一两分钟。";
    try {
      const report = await api(`/api/reports/${encodeURIComponent(activeReportId)}/brief`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      activeReport = report;
      openSelectedReportPage("brief");
    } catch (error) {
      briefStatus = error.message;
    }
  }

  function closeEventSource() {
    if (!eventSource) return;
    eventSource.close();
    eventSource = null;
  }

  function statusBadgeClass(status) {
    return {
      queued: "badge-ghost",
      running: "badge-info",
      complete: "badge-success",
      error: "badge-error",
    }[status || "queued"];
  }

  function metricHint(label) {
    if (label === "全部报告") return latestReport ? `${latestReport.ticker} 最近更新` : "尚未生成报告";
    if (label === "已完成") return reports.length ? `${Math.round((completeReports / reports.length) * 100)}% 完成率` : "等待首次分析";
    if (label === "分析中") return runningReports ? "可从左侧切换跟踪" : "当前无运行任务";
    return errorReports ? "失败任务可重新分析" : "暂无失败任务";
  }
</script>

<svelte:head>
  <title>TradingAgents 股票分析</title>
</svelte:head>

<div class="min-h-screen bg-base-200 text-base-content lg:grid lg:grid-cols-[19rem_minmax(0,1fr)]">
  <aside class="sticky top-0 z-20 flex h-auto max-h-screen flex-col border-b border-base-300 bg-base-100/95 p-4 backdrop-blur lg:h-screen lg:border-b-0 lg:border-r">
    <div class="flex items-center gap-3">
      <div class="grid h-11 w-11 place-items-center rounded-lg bg-primary text-sm font-black text-primary-content">TA</div>
      <div>
        <h1 class="text-xl font-bold leading-tight">分析工作台</h1>
        <p class="text-sm text-base-content/60">TradingAgents</p>
      </div>
    </div>

    <button class="btn btn-primary mt-4 min-h-11 rounded-lg" type="button" on:click={startNewAnalysis}>
      <Plus size={18} />
      新建分析
    </button>

    <section class="mt-5 flex min-h-0 flex-1 flex-col">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="flex items-center gap-2 text-base font-bold"><History size={18} /> 历史报告</h2>
        <span class="badge badge-ghost">{reports.length}</span>
      </div>

      <label class="input input-bordered flex h-11 items-center gap-2 rounded-lg bg-base-100">
        <Search size={16} />
        <input bind:value={historySearch} on:input={scheduleHistorySearch} type="search" class="grow" placeholder="股票或日期" />
      </label>

      <div class="mt-3 flex flex-wrap gap-2" aria-label="历史报告筛选">
        {#each statusFilters as [key, label]}
          <button class="btn btn-sm rounded-full {statusFilter === key ? 'btn-primary' : 'btn-ghost'}" type="button" on:click={() => (statusFilter = key)}>
            {label}
          </button>
        {/each}
      </div>

      <div class="mt-3 grid min-h-0 flex-1 content-start gap-2 overflow-auto pr-1">
        {#if loadingReports && !reports.length}
          <div class="skeleton h-20 rounded-lg"></div>
          <div class="skeleton h-20 rounded-lg"></div>
        {:else if launchError}
          <div class="alert alert-error rounded-lg text-sm"><AlertCircle size={18} /> {launchError}</div>
        {:else if !filteredReports.length}
          <div class="rounded-lg border border-dashed border-base-300 bg-base-200 p-4 text-sm text-base-content/60">没有匹配的历史报告。</div>
        {:else}
          {#each filteredReports as report (report.id)}
            <div class="group grid grid-cols-[1fr_auto] overflow-hidden rounded-lg border border-base-300 bg-base-100 {report.id === activeReportId ? 'ring-2 ring-primary/50' : ''}">
              <button class="grid gap-1 p-3 text-left hover:bg-base-200" type="button" on:click={() => openReport(report.id)}>
                <span class="flex items-center justify-between gap-2">
                  <strong>{report.ticker}</strong>
                  <span class="badge badge-sm {statusBadgeClass(report.status)}">{statusText(report.status)}</span>
                </span>
                <span class="text-xs text-base-content/60">{report.analysisDate} · {report.depth} · {durationText(report.durationSeconds)}</span>
                <span class="truncate text-sm text-base-content/75">{decisionText(report.decision)}</span>
              </button>
              {#if report.status !== "running"}
                <button class="btn btn-ghost btn-sm m-2 opacity-60 hover:opacity-100" aria-label={`删除 ${report.ticker} 报告`} type="button" on:click={() => deleteReport(report.id, report.ticker)}>
                  <Trash2 size={16} />
                </button>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    </section>

    <button class="btn btn-outline mt-4 rounded-lg" type="button" on:click={() => (settingsOpen = true)}>
      <Settings size={17} />
      设置
    </button>
  </aside>

  <main class="min-w-0 p-4 lg:p-8">
    <header class="flex flex-col gap-4 border-b border-base-300 pb-5 xl:flex-row xl:items-start xl:justify-between">
      <div class="max-w-4xl">
        {#if activeTickerTitle}
          <p class="text-sm font-semibold uppercase tracking-normal text-primary">当前分析</p>
          <h2 class="mt-1 text-3xl font-bold leading-tight">{activeTickerTitle}</h2>
        {:else}
          <p class="text-sm font-semibold uppercase tracking-normal text-primary">股票分析报告平台</p>
          <h2 class="mt-1 text-3xl font-bold leading-tight">输入股票代码，生成可追踪的多智能体分析报告</h2>
          <p class="mt-2 max-w-3xl text-base text-base-content/65">支持单个或多个股票。平台会自动排队、展示进度，并沉淀为可阅读、可对比的报告。</p>
        {/if}
      </div>
      <div class="badge badge-lg badge-outline gap-2 self-start rounded-lg px-4 py-4">
        <BarChart3 size={16} />
        {modelChip}
      </div>
    </header>

    {#if showAnalysisEntry}
      <section class="mt-6 grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_23rem]">
        <div class="rounded-lg border border-base-300 bg-base-100 p-4 shadow-sm">
          <label class="form-control">
            <span class="label-text font-semibold">想分析哪些股票？</span>
            <textarea bind:value={tickerInput} on:keydown={handleTickerKeydown} on:input={() => { activeReport = null; activeReportId = null; }} class="textarea textarea-bordered mt-2 min-h-24 rounded-lg text-base" inputmode="latin" placeholder="输入 AAPL、MSFT 或一行一个股票代码"></textarea>
            <span class="label-text-alt mt-2 text-base-content/60">{inputHint}</span>
          </label>

          <div class="mt-4 flex flex-wrap items-center gap-2">
            <span class="text-sm text-base-content/60">示例</span>
            {#each examples as example}
              <button class="btn btn-sm btn-ghost rounded-full" type="button" on:click={() => (tickerInput = example)}>{example}</button>
            {/each}
          </div>

          <div class="mt-5 grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
            <div class="join grid grid-cols-3">
              {#each depths as item}
                <button class="btn join-item h-auto min-h-16 flex-col rounded-none {depth === item.key ? 'btn-primary' : 'btn-outline'}" type="button" on:click={() => (depth = item.key)}>
                  <strong>{item.title}</strong>
                  <span class="text-xs font-normal opacity-75">{item.hint}</span>
                </button>
              {/each}
            </div>
            <div class="flex gap-2">
              <button class="btn btn-primary rounded-lg" type="button" disabled={!canStart} on:click={startAnalysis}>
                {#if jobStatus === "分析中"}<Loader2 class="animate-spin" size={17} />{:else}<Play size={17} />{/if}
                {startButtonText}
              </button>
              <button class="btn btn-ghost rounded-lg" type="button" on:click={() => (tickerInput = "")}>清空</button>
            </div>
          </div>

          <div class="mt-4 flex flex-wrap gap-2">
            <span class="badge badge-neutral rounded-lg">待分析 {tickers.length} 个</span>
            {#each tickers as ticker}
              <button class="badge badge-outline gap-1 rounded-lg py-3" type="button" on:click={() => removeTicker(ticker)}>
                {ticker}<X size={12} />
              </button>
            {/each}
          </div>
        </div>

        <ol class="grid gap-3 rounded-lg border border-base-300 bg-base-100 p-4 text-sm shadow-sm">
          <li class="flex gap-3"><span class="badge badge-primary rounded-lg">1</span><span><strong>输入股票</strong><br /><span class="text-base-content/60">支持逗号、空格或换行分隔。</span></span></li>
          <li class="flex gap-3"><span class="badge badge-primary rounded-lg">2</span><span><strong>选择深度</strong><br /><span class="text-base-content/60">浅度适合快速试跑，深度适合正式研判。</span></span></li>
          <li class="flex gap-3"><span class="badge badge-primary rounded-lg">3</span><span><strong>查看报告</strong><br /><span class="text-base-content/60">完成后生成简报、打开阅读页、横向对比。</span></span></li>
        </ol>
      </section>

      <p class="mt-3 text-sm text-base-content/55">仅供研究参考，不构成投资建议。</p>
    {/if}

    {#if viewMode === "active"}
      <div class="mt-6 grid gap-4 2xl:grid-cols-[minmax(0,1.15fr)_minmax(28rem,0.85fr)]">
        {#if hasSelectedReport}
          <section class="rounded-lg border border-base-300 bg-base-100 p-4 shadow-sm 2xl:col-span-2">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 class="text-xl font-bold">报告查看</h2>
                <p class="text-sm text-base-content/60">
                  {activeReport.ticker} · {activeReport.analysisDate} · {activeReport.depth} · 耗时 {durationText(activeReport.durationSeconds)}
                </p>
              </div>
              <span class="badge badge-lg {statusBadgeClass(activeReport.status)}">{statusText(activeReport.status)}</span>
            </div>

            <div class="mt-4 grid auto-rows-fr gap-3 lg:grid-cols-4">
              <div class="rounded-lg border border-primary/20 bg-primary/10 p-5 lg:col-span-2 lg:row-span-2">
                <div class="flex items-center gap-2 text-primary">
                  <FileText size={18} />
                  <span class="text-sm font-bold">已选择报告</span>
                </div>
                <h3 class="mt-3 text-2xl font-black leading-tight">{activeReport.ticker} 原始分析报告</h3>
                <p class="mt-2 line-clamp-3 text-sm text-base-content/70">
                  {activeReport.summary || activeReport.error || "暂无摘要，打开报告页查看完整输出。"}
                </p>
                <div class="mt-5 flex flex-wrap gap-2">
                  <button class="btn btn-primary rounded-lg" type="button" disabled={!activeReport.reportMarkdown && !activeReport.error && !activeReport.summary} on:click={() => openSelectedReportPage()}>
                    打开查看原始报告
                  </button>
                  <button class="btn btn-outline rounded-lg" type="button" disabled={activeReport.status !== "complete" || (!activeReport.reportMarkdown && !activeReport.briefHtml)} on:click={generateSelectedBrief}>
                    {activeReport.briefHtml ? "查看分析简报" : "生成分析简报"}
                  </button>
                </div>
                {#if briefStatus}<p class="mt-3 text-sm text-base-content/60">{briefStatus}</p>{/if}
              </div>

              <div class="rounded-lg border border-base-300 bg-base-200 p-4">
                <dt class="text-xs font-semibold uppercase tracking-normal text-base-content/50">状态</dt>
                <dd class="mt-2 text-lg font-black">{statusText(activeReport.status)}</dd>
              </div>
              <div class="rounded-lg border border-base-300 bg-base-200 p-4">
                <dt class="text-xs font-semibold uppercase tracking-normal text-base-content/50">决策</dt>
                <dd class="mt-2 text-lg font-black">{decisionText(activeReport.decision)}</dd>
              </div>
              <div class="rounded-lg border border-base-300 bg-base-200 p-4">
                <dt class="text-xs font-semibold uppercase tracking-normal text-base-content/50">耗时</dt>
                <dd class="mt-2 text-sm font-bold">{durationText(activeReport.durationSeconds)}</dd>
              </div>
              <div class="rounded-lg border border-base-300 bg-base-200 p-4">
                <dt class="text-xs font-semibold uppercase tracking-normal text-base-content/50">日志</dt>
                <dd class="mt-2 text-sm font-bold">{activeReport.logs?.length || 0} 条</dd>
              </div>
            </div>
          </section>
        {/if}

        <section class="rounded-lg border border-base-300 bg-base-100 p-4 shadow-sm">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 class="text-xl font-bold">实时进度</h2>
              <p class="text-sm text-base-content/60">{currentJobText}</p>
            </div>
            <div class="flex items-center gap-2">
              <span class="badge badge-lg {activeReport?.status ? statusBadgeClass(activeReport.status) : 'badge-info'}">{jobStatus}</span>
              {#if activeReport?.status === "error"}
                <button class="btn btn-sm btn-outline rounded-lg" type="button" on:click={startAnalysis}>重新分析</button>
              {/if}
            </div>
          </div>

          <ol class="mt-5 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
            {#each stages as stage}
              <li class="rounded-lg border p-3 text-sm {completedStages.has(stage) ? 'border-success bg-success/10 text-success' : currentStage === stage ? 'border-primary bg-primary/10 text-primary' : 'border-base-300 bg-base-200 text-base-content/65'}">
                <span class="flex items-center gap-2">
                  {#if completedStages.has(stage)}<CheckCircle2 size={16} />{:else if currentStage === stage}<Clock3 size={16} />{:else}<span class="h-4 w-4 rounded-full border border-current"></span>{/if}
                  {stage}
                </span>
              </li>
            {/each}
          </ol>

          <div class="tabs tabs-boxed mt-5 w-fit rounded-lg bg-base-200">
            <button class="tab {logTab === 'logs' ? 'tab-active' : ''}" type="button" on:click={() => (logTab = "logs")}>运行日志</button>
            <button class="tab {logTab === 'errors' ? 'tab-active' : ''}" type="button" on:click={() => (logTab = "errors")}>错误详情 <span class="badge badge-sm ml-2">{errorLogs.length}</span></button>
          </div>

          {#if logTab === "logs"}
            <div bind:this={logListNode} class="mt-3 grid max-h-[24rem] gap-2 overflow-auto rounded-lg border border-base-300 bg-base-200 p-3">
              {#if !logs.length}
                <div class="p-4 text-sm text-base-content/60">实时日志会显示在这里。</div>
              {:else}
                {#each logs as event, index (event.id || `${event.at}-${index}`)}
                  <div class="rounded-lg bg-base-100 p-3">
                    <div class="flex flex-wrap items-center gap-2 text-xs text-base-content/55"><time>{formatTime(event.at)}</time><strong>{event.stage || event.type || "日志"}</strong></div>
                    <pre class="mt-1 whitespace-pre-wrap break-words font-sans text-sm">{event.message || ""}{event.payload?.error ? `（${event.payload.error}）` : ""}</pre>
                  </div>
                {/each}
              {/if}
            </div>
          {:else}
            <div bind:this={errorListNode} class="mt-3 grid max-h-[24rem] gap-2 overflow-auto rounded-lg border border-error/30 bg-error/5 p-3">
              {#if !errorLogs.length}
                <div class="p-4 text-sm text-base-content/60">暂无错误详情。</div>
              {:else}
                {#each errorLogs as event, index (event.id || `${event.at}-${index}`)}
                  <div class="rounded-lg bg-base-100 p-3">
                    <div class="flex flex-wrap items-center gap-2 text-xs text-error"><time>{formatTime(event.at)}</time><strong>{event.stage || event.type || "错误"}</strong></div>
                    <pre class="mt-1 whitespace-pre-wrap break-words text-sm">{event.message || ""}{event.payload?.error ? `（${event.payload.error}）` : ""}</pre>
                  </div>
                {/each}
              {/if}
            </div>
          {/if}
        </section>

        {#if showOverview}
          <section class="rounded-lg border border-base-300 bg-base-100 p-4 shadow-sm">
            <h2 class="text-xl font-bold">平台总览</h2>
            <p class="text-sm text-base-content/60">汇总当前报告状态，便于快速判断任务健康度。</p>
            <div class="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {#each [["全部报告", reports.length], ["已完成", completeReports], ["分析中", runningReports], ["需处理", errorReports]] as [label, value]}
                <div class="rounded-lg border border-base-300 bg-base-200 p-4">
                  <span class="text-sm text-base-content/60">{label}</span>
                  <strong class="mt-1 block text-3xl">{value}</strong>
                  <small class="text-base-content/55">{metricHint(label)}</small>
                </div>
              {/each}
            </div>

            <div class="mt-5">
              <h3 class="font-bold">最近报告对比</h3>
              <p class="text-sm text-base-content/60">{comparisonReports.length ? `展示最近 ${comparisonReports.length} 份完成报告。` : "完成分析后可在这里横向查看结论、耗时和简报状态。"}</p>
              <div class="mt-3 overflow-x-auto rounded-lg border border-base-300">
                {#if !comparisonReports.length}
                  <div class="p-4 text-sm text-base-content/60">还没有可对比的完成报告。</div>
                {:else}
                  <table class="table table-sm bg-base-100">
                    <thead><tr><th>股票</th><th>日期</th><th>深度</th><th>决策</th><th>耗时</th><th>简报</th></tr></thead>
                    <tbody>
                      {#each comparisonReports as report}
                        <tr>
                          <td><button class="link link-primary font-bold" type="button" on:click={() => openReport(report.id)}>{report.ticker}</button></td>
                          <td>{report.analysisDate}</td>
                          <td>{report.depth}</td>
                          <td>{decisionText(report.decision)}</td>
                          <td>{durationText(report.durationSeconds)}</td>
                          <td>{report.briefHtml ? "已生成" : "未生成"}</td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                {/if}
              </div>
            </div>
          </section>
        {/if}

        {#if showQueue}
          <section class="rounded-lg border border-base-300 bg-base-100 p-4 shadow-sm">
            <h2 class="text-xl font-bold">分析队列</h2>
            <p class="text-sm text-base-content/60">{queueReports.length ? `${queueReports.length} 个任务，${queueReports.filter((item) => item.status === "running" || item.status === "queued").length} 个仍在推进。` : "批量启动后会显示每个股票的任务状态。"}</p>
            <div class="mt-4 grid gap-2">
              {#if !queueReports.length}
                <div class="rounded-lg border border-dashed border-base-300 p-4 text-sm text-base-content/60">暂无运行中的分析队列。</div>
              {:else}
                {#each queueReports as item}
                  <button class="flex items-center justify-between rounded-lg border border-base-300 bg-base-200 p-3 text-left hover:bg-base-100 disabled:cursor-not-allowed disabled:opacity-60 {item.id === activeReportId ? 'ring-2 ring-primary/50' : ''}" type="button" disabled={!item.id} on:click={() => item.id && openReport(item.id)}>
                    <span><strong>{item.ticker}</strong><br /><small class="text-base-content/60">{item.analysisDate || "今日"} · {item.depth || depthText(depth)}</small></span>
                    <span class="badge {statusBadgeClass(item.status)}">{statusText(item.status || "queued")}</span>
                  </button>
                {/each}
              {/if}
            </div>
          </section>
        {/if}
      </div>
    {/if}
  </main>
</div>

{#if settingsOpen}
  <div class="modal modal-open">
    <div class="modal-box max-w-5xl rounded-lg p-0">
      <div class="grid md:grid-cols-[15rem_1fr]">
        <aside class="border-b border-base-300 bg-base-200 p-4 md:border-b-0 md:border-r">
          <p class="text-sm font-semibold uppercase tracking-normal text-primary">系统设置</p>
          <h2 class="mt-1 text-2xl font-bold">设置</h2>
          <div class="mt-5 grid gap-2">
            {#each Object.entries(settingsTabs) as [key, value]}
              <button class="btn justify-start rounded-lg {settingsTab === key ? 'btn-primary' : 'btn-ghost'}" type="button" on:click={() => (settingsTab = key)}>{value[0]}</button>
            {/each}
          </div>
        </aside>

        <section class="p-5">
          <div class="flex items-start justify-between gap-4">
            <div>
              <h3 class="text-xl font-bold">{settingsTabs[settingsTab][0]}</h3>
              <p class="text-sm text-base-content/60">{settingsTabs[settingsTab][1]}</p>
            </div>
            <button class="btn btn-ghost btn-sm rounded-lg" type="button" on:click={() => (settingsOpen = false)}><X size={18} /> 关闭</button>
          </div>

          <form class="mt-5 grid gap-4" on:submit|preventDefault={saveSettings}>
            {#if settingsTab === "llm"}
              <label class="form-control"><span class="label-text">Provider</span><input class="input input-bordered rounded-lg" bind:value={form.provider} readonly /></label>
              <label class="form-control"><span class="label-text">快速模型</span><select class="select select-bordered rounded-lg" bind:value={form.quickModel}><option value="deepseek-v4-flash">deepseek-v4-flash</option><option value="deepseek-v4-pro">deepseek-v4-pro</option></select></label>
              <label class="form-control"><span class="label-text">深度模型</span><select class="select select-bordered rounded-lg" bind:value={form.deepModel}><option value="deepseek-v4-pro">deepseek-v4-pro</option><option value="deepseek-v4-flash">deepseek-v4-flash</option></select></label>
              <label class="form-control"><span class="label-text">Temperature</span><input class="input input-bordered rounded-lg" type="number" min="0" max="2" step="0.1" placeholder="留空使用默认" bind:value={form.temperature} /></label>
            {:else if settingsTab === "api"}
              <label class="form-control"><span class="label-text">DeepSeek API Key</span><input class="input input-bordered rounded-lg" type="password" autocomplete="new-password" placeholder={settings?.llm?.apiKey ? "已保存，留空则保持当前 Key" : "sk-..."} bind:value={form.apiKey} /></label>
              <p class="text-sm text-base-content/60">API Key 会保存在本机 data/app_state.json，适合可信内网环境。</p>
            {:else if settingsTab === "runtime"}
              <label class="form-control"><span class="label-text">Python 命令</span><input class="input input-bordered rounded-lg" bind:value={form.pythonPath} placeholder="python3" /></label>
              <label class="form-control"><span class="label-text">TradingAgents 目录</span><input class="input input-bordered rounded-lg" bind:value={form.tradingAgentsDir} /></label>
              <label class="form-control"><span class="label-text">运行结果目录</span><input class="input input-bordered rounded-lg" bind:value={form.resultsDir} /></label>
            {:else}
              <label class="label cursor-pointer justify-start gap-3 rounded-lg border border-base-300 p-4"><input class="checkbox checkbox-primary" type="checkbox" bind:checked={form.largeText} /><span>使用更大的界面字体</span></label>
            {/if}

            <div class="modal-action items-center">
              <span class="mr-auto text-sm text-base-content/60" aria-live="polite">{settingsMessage}</span>
              <button class="btn btn-ghost rounded-lg" type="button" on:click={() => (settingsOpen = false)}>取消</button>
              <button class="btn btn-primary rounded-lg" type="submit">保存设置</button>
            </div>
          </form>
        </section>
      </div>
    </div>
    <button class="modal-backdrop" type="button" aria-label="关闭设置" on:click={() => (settingsOpen = false)}></button>
  </div>
{/if}
