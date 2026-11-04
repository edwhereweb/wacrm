"use client";

import { createContext, useContext } from "react";
import type { DealKeywordMatch } from "@/lib/pipelines/search";

/**
 * Keyword hits (from messages / notes) for the current board search,
 * keyed by deal id. Lets a deal card show why it matched without
 * threading a prop through the board and its columns.
 */
export const DealSearchMatchContext = createContext<ReadonlyMap<string, DealKeywordMatch>>(
  new Map(),
);

export function useDealSearchMatch(dealId: string): DealKeywordMatch | undefined {
  return useContext(DealSearchMatchContext).get(dealId);
}
