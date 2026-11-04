import type { Deal } from "@/types";

/** Keyword search (messages + notes) only runs from this many characters. */
export const KEYWORD_SEARCH_MIN_CHARS = 3;

/** A keyword hit from the `search_pipeline_deals` database function. */
export interface DealKeywordMatch {
  deal_id: string;
  source: "message" | "note";
  snippet: string | null;
  matched_at: string | null;
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Does the deal match a search typed on the pipeline board?
 *
 * Text fields (deal title, contact name, email, company, deal notes)
 * match case-insensitively on a substring. Phone numbers compare digits
 * only, so "98765 43210", "+91 9876543210" and "919876543210" all find
 * a contact saved as "+919876543210".
 */
export function dealMatchesQuery(deal: Deal, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  const contact = deal.contact;
  const textFields = [
    deal.title,
    deal.notes,
    contact?.name,
    contact?.email,
    contact?.company,
    contact?.phone,
  ];
  if (textFields.some((f) => f && f.toLowerCase().includes(q))) return true;

  // Only treat it as a phone search when the query is mostly digits;
  // otherwise "a1" would match every number containing a 1.
  const qDigits = digitsOnly(q);
  if (qDigits.length >= 4 && qDigits.length >= q.replace(/[\s+()-]/g, "").length) {
    const phoneDigits = digitsOnly(contact?.phone ?? "");
    if (phoneDigits.includes(qDigits)) return true;
  }
  return false;
}

/**
 * Deals to show for a search: those matching on name / phone / etc.,
 * plus those the keyword search found in messages or notes. Keeps the
 * original order so the board's per-stage ordering is unchanged.
 */
export function filterDeals(
  deals: Deal[],
  query: string,
  keywordMatches: ReadonlyMap<string, DealKeywordMatch>,
): Deal[] {
  if (!query.trim()) return deals;
  return deals.filter(
    (d) => dealMatchesQuery(d, query) || keywordMatches.has(d.id),
  );
}
