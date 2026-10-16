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

function lmsKey(phone: string | null, email: string | null) {
  return `${phone?.trim() ?? ""}|${email?.trim().toLowerCase() ?? ""}`;
}

async function loadEnrollments(
  phone: string | null,
  email: string | null,
): Promise<LmsEnrollmentsResult> {
  const params = new URLSearchParams();
  if (phone?.trim()) params.set("phone", phone.trim());
  if (email?.trim()) params.set("email", email.trim());
  let res: Response;
  try {
    res = await fetch(`/api/integrations/lms/enrollments?${params}`);
  } catch {
    throw new LmsFetchError("network");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new LmsFetchError((body?.code as LmsErrorCode) ?? "unreachable");
  }
  return body as LmsEnrollmentsResult;
}

export function fetchLmsEnrollmentsCached(
  phone: string | null,
  email: string | null,
  force = false,
) {
  return lmsEnrollmentsCache.get(
    lmsKey(phone, email),
    () => loadEnrollments(phone, email),
    { force },
  );
}

export function useLmsEnrollments(
  phone: string | null,
  email: string | null,
  enabled: boolean,
) {
  const hasId = !!(phone?.trim() || email?.trim());
  const key = lmsKey(phone, email);
  const [data, setData] = useState<LmsEnrollmentsResult | null>(null);
  const [error, setError] = useState<LmsFetchError["code"] | null>(null);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);

  const run = useCallback(
    async (force: boolean) => {
      if (!hasId) return;
      const id = ++requestId.current;
      const cached = force ? undefined : lmsEnrollmentsCache.peek(key);
      if (cached) {
        setData(cached);
        setError(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result = await fetchLmsEnrollmentsCached(phone, email, force);
        if (id !== requestId.current) return;
        if (result.enrollments.length === 0) {
          lmsEnrollmentsCache.delete(key);
        }
        setData(result);
      } catch (err) {
        if (id !== requestId.current) return;
        setData(null);
        setError(err instanceof LmsFetchError ? err.code : "unreachable");
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [phone, email, hasId, key],
  );

  useEffect(() => {
    if (!enabled || !hasId) return;
    run(false);
    const ref = requestId;
    return () => {
      ref.current++;
    };
  }, [enabled, hasId, key, run]);

  const refresh = useCallback(() => run(true), [run]);
  return { data, error, loading, refresh };
}
