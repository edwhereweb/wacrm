import { describe, expect, it } from "vitest";
import type { Deal } from "@/types";
import { dealMatchesQuery, filterDeals, type DealKeywordMatch } from "./search";

function deal(id: string, overrides: Partial<Deal> = {}, contact: Partial<NonNullable<Deal["contact"]>> = {}): Deal {
  return {
    id,
    user_id: "u",
    pipeline_id: "p",
    stage_id: "s",
    contact_id: `c-${id}`,
    title: `Deal ${id}`,
    value: 0,
    created_at: "2026-01-01T00:00:00Z",
    contact: {
      id: `c-${id}`,
      phone: "+919876543210",
      name: "Anjali Menon",
      ...contact,
    } as Deal["contact"],
    ...overrides,
  };
}

describe("dealMatchesQuery", () => {
  it("matches every deal on an empty query", () => {
    expect(dealMatchesQuery(deal("1"), "  ")).toBe(true);
  });

  it("matches contact name case-insensitively", () => {
    expect(dealMatchesQuery(deal("1"), "anjali")).toBe(true);
    expect(dealMatchesQuery(deal("1"), "MENON")).toBe(true);
    expect(dealMatchesQuery(deal("1"), "rahul")).toBe(false);
  });

  it("matches the deal title, email, company and deal notes", () => {
    const d = deal("1", { title: "Python batch", notes: "Wants weekend slot" }, {
      email: "anjali@example.com",
      company: "Infopark",
    });
    expect(dealMatchesQuery(d, "python")).toBe(true);
    expect(dealMatchesQuery(d, "weekend")).toBe(true);
    expect(dealMatchesQuery(d, "example.com")).toBe(true);
    expect(dealMatchesQuery(d, "infopark")).toBe(true);
  });

  it("matches phone numbers however they are typed", () => {
    const d = deal("1");
    expect(dealMatchesQuery(d, "9876543210")).toBe(true);
    expect(dealMatchesQuery(d, "98765 43210")).toBe(true);
    expect(dealMatchesQuery(d, "+91 98765-43210")).toBe(true);
    expect(dealMatchesQuery(d, "43210")).toBe(true);
    expect(dealMatchesQuery(d, "11111")).toBe(false);
  });

  it("does not treat short or mixed text as a phone search", () => {
    expect(dealMatchesQuery(deal("1"), "a98")).toBe(false);
  });

  it("handles a deal whose contact was deleted", () => {
    const d = { ...deal("1"), contact: undefined, contact_id: null };
    expect(dealMatchesQuery(d, "deal 1")).toBe(true);
    expect(dealMatchesQuery(d, "anjali")).toBe(false);
  });
});

describe("filterDeals", () => {
  const deals = [deal("1"), deal("2", {}, { name: "Rahul" }), deal("3", {}, { name: "Sneha" })];

  it("returns all deals for an empty query", () => {
    expect(filterDeals(deals, "", new Map())).toBe(deals);
  });

  it("keeps keyword (message / note) matches and preserves order", () => {
    const hits = new Map<string, DealKeywordMatch>([
      ["3", { deal_id: "3", source: "message", snippet: "second week", matched_at: null }],
    ]);
    expect(filterDeals(deals, "rahul", hits).map((d) => d.id)).toEqual(["2", "3"]);
  });
});
