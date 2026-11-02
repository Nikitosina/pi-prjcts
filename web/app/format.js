export function clip(value, size) {
  return value.length > size ? `${value.slice(0, size - 1)}…` : value;
}
export function duration(ms) {
  const s = Math.floor(ms / 1000);
  return s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.floor(s / 60)}m`
      : s < 86400
        ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
        : `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
export function ago(at) {
  const ms = Date.now() - new Date(at).getTime();
  return ms < 60000 ? "just now" : `${duration(ms)} ago`;
}
export function size(bytes) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}
export function badge(value) {
  return `<span class="badge ${esc(value)}"><span class="dot"></span>${esc(value)}</span>`;
}
export function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
export const idLike = (text) => /^[a-f0-9-]{36,64}$/.test(text);
export function uuid(value) {
  return typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
}
