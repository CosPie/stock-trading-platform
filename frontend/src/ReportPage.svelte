<script>
  import { onDestroy, onMount, tick } from "svelte";
  import { ArrowLeft, Copy, FileText, Printer, Search, Sparkles, Upload } from "@lucide/svelte";
  import { api, reportIdFromPath, statusText } from "./api";
  import { collectTocFromElement, compactToc, extractBriefMarkup, renderMarkdown } from "./markdown";

  let report = null;
  let view = new URLSearchParams(window.location.search).get("view") || "raw";
  let title = "报告查看";
  let meta = "正在加载...";
  let rawHtml = "";
  let briefHtml = "";
  let rawToc = [];
  let briefToc = [];
  let searchQuery = "";
  let searchCount = "";
  let copyText = "复制链接";
  let loading = true;
  let generating = false;
  let showBackToTop = false;
  let activeHeading = "";
  let headingObserver = null;
  let searchTimer;
  let rawContentNode;
  let briefContentNode;

  $: toc = view === "brief" ? briefToc : rawToc;
  $: hasBrief = Boolean(String(report?.briefHtml || "").trim());
  $: canGenerate = report?.status === "complete" && report?.reportMarkdown && !hasBrief && !generating;
  $: activeRoot = view === "brief" ? briefContentNode : rawContentNode;

  onMount(async () => {
    document.addEventListener("keydown", handleShortcut);
    window.addEventListener("scroll", updateBackToTopVisibility, { passive: true });
    await loadReport();
    await tick();
    observeActiveHeadings();
    applySearch({ scroll: false });
  });

  onDestroy(() => {
    document.removeEventListener("keydown", handleShortcut);
    window.removeEventListener("scroll", updateBackToTopVisibility);
    clearTimeout(searchTimer);
    if (headingObserver) headingObserver.disconnect();
  });

  async function loadReport() {
    loading = true;
    try {
      report = await api(`/api/reports/${encodeURIComponent(reportIdFromPath())}`);
      title = `${report.ticker} 报告`;
      meta = `${report.analysisDate} · ${report.depth} · ${statusText(report.status)}`;
      const rendered = renderMarkdown(report.reportMarkdown || report.summary || report.error || "暂无报告内容。");
      rawHtml = rendered.html;
      rawToc = compactToc(rendered.toc);
      renderBrief(report.briefHtml);
    } catch (error) {
      view = "raw";
      title = "报告加载失败";
      meta = "请返回首页重新选择报告。";
      rawHtml = `<div class="alert alert-error rounded-lg"><span>无法加载报告：${escapeHTML(error.message)}</span></div>`;
      rawToc = [];
      briefHtml = "";
      briefToc = [];
    } finally {
      loading = false;
    }
  }

  async function renderBrief(html) {
    const content = String(html || "").trim();
    briefHtml = content ? extractBriefMarkup(content) : "";
    await tick();
    briefToc = briefContentNode && content ? compactToc(collectTocFromElement(briefContentNode)) : [];
  }

  async function setView(next) {
    view = next;
    await tick();
    observeActiveHeadings();
    applySearch({ scroll: false });
  }

  async function generateBrief() {
    generating = true;
    view = "brief";
    briefHtml = "";
    await tick();
    try {
      report = await api(`/api/reports/${encodeURIComponent(reportIdFromPath())}/brief`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await renderBrief(report.briefHtml);
      observeActiveHeadings();
      applySearch({ scroll: false });
    } catch (error) {
      briefHtml = `<div class="alert alert-error rounded-lg"><span>生成失败：${escapeHTML(error.message)}</span></div>`;
    } finally {
      generating = false;
    }
  }

  function updateBackToTopVisibility() {
    showBackToTop = window.scrollY > 520;
  }

  function scheduleSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => applySearch(), 120);
  }

  function handleSearchKeydown(event) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const hits = activeRoot?.querySelectorAll(".report-search-hit") || [];
    if (!hits.length) return;
    const current = Array.from(hits).findIndex((node) => node.classList.contains("is-current"));
    const next = hits[(current + 1 + hits.length) % hits.length];
    hits.forEach((node) => node.classList.remove("is-current"));
    next.classList.add("is-current");
    next.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function handleShortcut(event) {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "k") {
      event.preventDefault();
      const input = document.getElementById("report-search");
      input?.focus();
      input?.select();
      return;
    }
    if (event.key === "Escape" && document.activeElement?.id === "report-search") {
      searchQuery = "";
      applySearch({ scroll: false });
    }
  }

  function applySearch(options = {}) {
    const { scroll = true } = options;
    if (!activeRoot) return;
    clearSearchHighlights(activeRoot);
    const query = searchQuery.trim();
    if (!query) {
      searchCount = "";
      return;
    }
    if (query.length < 2) {
      searchCount = "至少 2 个字";
      return;
    }
    const count = highlightText(activeRoot, query);
    searchCount = count ? `${count} 处匹配` : "无匹配";
    if (!count || !scroll) return;
    const first = activeRoot.querySelector(".report-search-hit");
    first?.classList.add("is-current");
    first?.scrollIntoView({ behavior: "smooth", block: "center" });
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

  function observeActiveHeadings() {
    if (headingObserver) headingObserver.disconnect();
    const root = view === "brief" ? briefContentNode : rawContentNode;
    const headings = Array.from(root?.querySelectorAll("h1[id], h2[id], h3[id]") || []);
    activeHeading = headings[0]?.id || "";
    if (!headings.length || !("IntersectionObserver" in window)) return;
    headingObserver = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) activeHeading = visible.target.id;
      },
      { rootMargin: "-18% 0px -72% 0px", threshold: 0 },
    );
    headings.forEach((heading) => headingObserver.observe(heading));
  }

  async function copyReportLink() {
    const text = window.location.href;
    try {
      await navigator.clipboard.writeText(text);
      copyText = "已复制";
    } catch {
      window.prompt("复制报告链接", text);
      copyText = "可手动复制";
    }
    setTimeout(() => (copyText = "复制链接"), 1600);
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function escapeHTML(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
</script>

<svelte:head>
  <title>{title} · TradingAgents</title>
</svelte:head>

<div class="min-h-screen bg-base-200 text-base-content">
  <header class="sticky top-0 z-30 border-b border-base-300 bg-base-100/95 px-4 py-4 backdrop-blur">
    <div class="mx-auto flex max-w-7xl flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
      <div class="flex items-start gap-4">
        <a class="btn btn-ghost btn-sm rounded-lg" href="/"><ArrowLeft size={17} /> 返回首页</a>
        <div>
          <p class="text-sm font-semibold uppercase tracking-normal text-primary">TradingAgents 报告</p>
          <h1 class="text-2xl font-bold leading-tight">{title}</h1>
          <p class="text-sm text-base-content/60">{meta}</p>
        </div>
      </div>

      <div class="flex flex-wrap items-end gap-2">
        <label class="form-control w-64 max-w-full">
          <span class="label-text">搜索报告</span>
          <label class="input input-bordered flex h-10 items-center gap-2 rounded-lg bg-base-100">
            <Search size={16} />
            <input id="report-search" bind:value={searchQuery} on:input={scheduleSearch} on:keydown={handleSearchKeydown} type="search" class="grow" placeholder="搜索关键词" disabled={loading} />
          </label>
          <span class="label-text-alt">{searchCount}</span>
        </label>
        <div class="tabs tabs-boxed rounded-lg bg-base-200">
          <button class="tab {view === 'brief' ? 'tab-active' : ''}" type="button" on:click={() => setView("brief")}>分析简报</button>
          <button class="tab {view === 'raw' ? 'tab-active' : ''}" type="button" on:click={() => setView("raw")}>原始报告</button>
        </div>
        <button class="btn btn-outline btn-sm rounded-lg" type="button" on:click={copyReportLink}><Copy size={16} /> {copyText}</button>
        <button class="btn btn-outline btn-sm rounded-lg" type="button" on:click={() => window.print()}><Printer size={16} /> 打印</button>
        <button class="btn btn-primary btn-sm rounded-lg" type="button" disabled={!canGenerate} on:click={generateBrief}>
          <Sparkles size={16} />
          {generating ? "生成中..." : hasBrief ? "已生成分析简报" : "生成分析简报"}
        </button>
      </div>
    </div>
  </header>

  <main class="mx-auto grid max-w-7xl gap-6 px-4 py-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
    <aside class="hidden lg:block">
      <div class="sticky top-28 rounded-lg border border-base-300 bg-base-100 p-4">
        <p class="mb-3 flex items-center gap-2 font-bold"><FileText size={17} /> 目录</p>
        <nav class="grid gap-1 text-sm">
          {#if !toc.length}
            <span class="text-base-content/55">暂无目录</span>
          {:else}
            {#each toc as item}
              <a class="rounded-md px-2 py-1 text-base-content/70 hover:bg-base-200 hover:text-base-content {activeHeading === item.id ? 'bg-primary/10 font-bold text-primary' : ''} {item.level === 3 ? 'pl-6' : item.level === 2 ? 'pl-4' : ''}" href={`#${item.id}`}>
                {item.text}
              </a>
            {/each}
          {/if}
        </nav>
      </div>
    </aside>

    <div class="min-w-0 rounded-lg border border-base-300 bg-base-100 p-4 shadow-sm md:p-8">
      {#if view === "brief"}
        <section class="report-view">
          {#if generating}
            <div class="grid min-h-72 place-items-center rounded-lg border border-dashed border-base-300 bg-base-200 p-8 text-center">
              <div>
                <span class="loading loading-spinner loading-lg text-primary"></span>
                <h2 class="mt-4 text-xl font-bold">正在生成分析简报</h2>
                <p class="mt-2 text-base-content/60">LLM 正在把原始报告改写成更容易阅读的页面。</p>
              </div>
            </div>
          {:else if briefHtml}
            <article bind:this={briefContentNode} class="brief-content report-content">{@html briefHtml}</article>
          {:else}
            <div class="grid min-h-72 place-items-center rounded-lg border border-dashed border-base-300 bg-base-200 p-8 text-center">
              <div>
                <Sparkles class="mx-auto text-primary" size={34} />
                <h2 class="mt-4 text-xl font-bold">还没有分析简报</h2>
                <p class="mt-2 max-w-xl text-base-content/60">点击“生成分析简报”，系统会调用 LLM，把原始报告改写成更容易阅读的 HTML 简报。</p>
                <button class="btn btn-primary mt-4 rounded-lg" type="button" disabled={!canGenerate} on:click={generateBrief}>生成分析简报</button>
              </div>
            </div>
          {/if}
        </section>
      {:else}
        <section class="report-view">
          {#if loading}
            <div class="grid gap-3">
              <div class="skeleton h-8 w-1/2"></div>
              <div class="skeleton h-24 w-full"></div>
              <div class="skeleton h-24 w-full"></div>
            </div>
          {:else}
            <article bind:this={rawContentNode} class="report-content">{@html rawHtml}</article>
          {/if}
        </section>
      {/if}
    </div>
  </main>

  <button class="btn btn-primary fixed bottom-5 right-5 rounded-lg shadow-lg transition {showBackToTop ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0'}" type="button" aria-label="回到顶部" on:click={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
    <Upload size={18} />
  </button>
</div>
