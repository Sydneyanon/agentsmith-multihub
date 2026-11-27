import type { RewardTier, Severity } from "./types.js";

/**
 * Deterministic reward parsing. It reads amounts that are written down and nothing else: "See program", "Discretionary" or a
 * stake notice give null amounts, never an estimate.
 */
const MULT: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, billion: 1e9 };

/** All money amounts in a text, in order. "$10,000", "$2.5M", "USD 50k", "250,000 USDC", "$1.5 million". */
export function amountsIn(text: string): number[] {
  const out: number[] = [];
  const re = /(?:\$|US\$|USD\s?|USDC\s?|€|£)\s?(\d{1,3}(?:[,\s]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?(k|m|mm|b|thousand|million|billion)?\b|(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?(k|m|mm|million|thousand)?\s?(?:USD|USDC|USDT|DAI)\b/gi;
  for (const m of text.matchAll(re)) {
    const num = (m[1] ?? m[3])!; const unit = (m[2] ?? m[4] ?? "").toLowerCase();
    const n = Number(num.replace(/[,\s]/g, "")) * (unit ? MULT[unit] ?? 1 : 1);
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

export function parseTierText(text: string): { min: number | null; max: number | null } {
  if (/see program|discretionary|stake\s/i.test(text) && amountsIn(text.replace(/stake\s+\$?[\d,]+/gi, "")).length === 0) return { min: null, max: null };
  const cleaned = text.replace(/stake\s+\$?[\d,]+/gi, "").replace(/\([^)]*%[^)]*\)/g, "");
  const a = amountsIn(cleaned);
  if (a.length === 0) return { min: null, max: null };
  if (/flat/i.test(cleaned) || a.length === 1) return /up to/i.test(cleaned) ? { min: null, max: a[0]! } : { min: a[0]!, max: a[0]! };
  return { min: Math.min(...a), max: Math.max(...a) };
}

export function severityOf(label: string): Severity {
  const l = label.toLowerCase();
  if (l.startsWith("crit")) return "critical";
  if (l.startsWith("high")) return "high";
  if (l.startsWith("med")) return "medium";
  if (l.startsWith("low")) return "low";
  if (l.startsWith("info")) return "informational";
  return "other";
}

export function tier(severityLabel: string, asset: string | null, text: string): RewardTier {
  const { min, max } = parseTierText(text);
  return { severity: severityOf(severityLabel), asset: asset && asset.trim() ? asset.trim() : null, text: text.trim(), min, max };
}

/** Stable-value currencies whose amounts are comparable in US dollars without a price feed. Anything else is not converted. */
const USD_LIKE = new Set(["USD", "USDC", "USDT", "DAI", "USDS", "BOLD", "DOLA", "USD0", "GHO", "FRAX", "PYUSD", "LUSD", "CRVUSD"]);
export function usdComparable(amount: number | null, currency: string | null): number | null {
  if (amount === null) return null;
  if (!currency) return null;
  const first = currency.trim().toUpperCase().split(/[\s+(]/)[0]!;
  return USD_LIKE.has(first) ? amount : null;
}
