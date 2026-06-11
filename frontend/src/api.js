export async function api(path, options = {}) {
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
      // Keep the response status text.
    }
    throw new Error(message);
  }
  return response.json();
}

export function parseTickers(value) {
  const seen = new Set();
  return String(value || "")
    .toUpperCase()
    .split(/[\s,，;；、]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

export function depthText(depth) {
  return { shallow: "浅度", medium: "中度", deep: "深度" }[depth] || "浅度";
}

export function depthKey(depth) {
  const value = String(depth || "").toLowerCase();
  if (value === "中度" || value === "medium") return "medium";
  if (value === "深度" || value === "deep" || value === "depth") return "deep";
  return "shallow";
}

export function statusText(status) {
  return { queued: "待启动", running: "分析中", complete: "已完成", error: "失败" }[status] || "待开始";
}

export function decisionText(decision) {
  return String(decision || "").trim() || "未提取";
}

export function durationText(seconds) {
  const value = Number(seconds || 0);
  if (!value) return "未记录";
  if (value < 60) return `${value} 秒`;
  const mins = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${mins} 分 ${rest} 秒` : `${mins} 分`;
}

export function formatTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function isErrorEvent(event) {
  const text = `${event?.stage || ""} ${event?.message || ""}`.toLowerCase();
  return (
    event?.type === "error" ||
    event?.stage === "系统输出" ||
    text.includes("failed") ||
    text.includes("traceback") ||
    text.includes("exception") ||
    text.includes("error:")
  );
}

export function reportIdFromPath() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}
