export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const seconds = Math.round((now.getTime() - then) / 1000);
  if (seconds < 0) return "in the future";
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}
export function exactTime(iso: string | null | undefined): string { return iso ? new Date(iso).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC") : "—"; }
export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}
export const shortHash = (hash: string | null | undefined, n = 10): string => (hash ? hash.slice(0, n) : "—");
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 90) return `${seconds} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
export function hostOf(url: string | null | undefined): string {
  if (!url) return "";
  try { return new URL(url).host; } catch { return url; }
}
