<script>
  import Dashboard from "./Dashboard.svelte";
  import ReportPage from "./ReportPage.svelte";

  const isReportPage = window.location.pathname.startsWith("/report/");
</script>

{#if isReportPage}
  <ReportPage />
{:else}
  <Dashboard />
{/if}
