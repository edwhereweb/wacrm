"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { TtlCache } from "@/lib/lms/cache";
import type { LmsEnrollmentsResult, LmsErrorCode } from "@/lib/lms/types";

export class LmsFetchError extends Error {
  constructor(readonly code: LmsErrorCode | "network") {
    super(code);
  }
}

// Module-level so the cache survives sidebar remounts and contact/tab
// switches within the session. Errors are never cached.
export const lmsEnrollmentsCache = new TtlCache<LmsEnrollmentsResult>();

async function loadEnrollments(phone: string): Promise<LmsEnrollmentsResult> {
  let res: Response;
  try {
    res = await fetch(
      `/api/integrations/lms/enrollments?phone=${encodeURIComponent(phone)}`,
    );
  } catch {
    throw new LmsFetchError("network");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new LmsFetchError((body?.code as LmsErrorCode) ?? "unreachable");
  }
  return body as LmsEnrollmentsResult;
}

export function fetchLmsEnrollmentsCached(phone: string, force = false) {
  return lmsEnrollmentsCache.get(phone, () => loadEnrollments(phone), { force });
}

export function useLmsEnrollments(phone: string | null, enabled: boolean) {
  const [data, setData] = useState<LmsEnrollmentsResult | null>(null);
  const [error, setError] = useState<LmsFetchError["code"] | null>(null);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);

  const run = useCallback(
    async (force: boolean) => {
      if (!phone) return;
      const id = ++requestId.current;
      const cached = force ? undefined : lmsEnrollmentsCache.peek(phone);
      if (cached) {
        setData(cached);
        setError(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result = await fetchLmsEnrollmentsCached(phone, force);
        if (id !== requestId.current) return;
        setData(result);
      } catch (err) {
        if (id !== requestId.current) return;
        setData(null);
        setError(err instanceof LmsFetchError ? err.code : "unreachable");
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [phone],
  );

  useEffect(() => {
    if (!enabled || !phone) return;
    run(false);
    const ref = requestId;
    return () => {
      ref.current++;
    };
  }, [enabled, phone, run]);

  const refresh = useCallback(() => run(true), [run]);
  return { data, error, loading, refresh };
}
