"use client";

import { useState } from "react";
import { format } from "date-fns";
import { useTranslations } from "next-intl";
import { AlertCircle, ChevronDown, GraduationCap, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLmsEnrollments } from "@/hooks/use-lms-enrollments";
import type { LmsEnrollment } from "@/lib/lms/types";

export function LmsEnrollmentsSection({
  phone,
  email = null,
}: {
  phone: string | null;
  email?: string | null;
}) {
  const t = useTranslations("Inbox.sidebar.lms");
  const [open, setOpen] = useState(true);
  const { data, error, loading, refresh } = useLmsEnrollments(phone, email, open);

  const errorKey =
    error === "misconfigured" ||
    error === "unauthorized" ||
    error === "timeout" ||
    error === "invalid_phone"
      ? error
      : "unreachable";

  const renderGroup = (kind: LmsEnrollment["kind"], items: LmsEnrollment[]) =>
    items.length > 0 && (
      <div key={kind} className="space-y-2">
        <p className="px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {t(kind === "course" ? "courses" : "webinars")}
        </p>
        {items.map((e) => (
          <div key={e.id} className="rounded-lg bg-muted px-3 py-2">
            <p className="text-sm font-medium text-foreground">{e.title}</p>
            <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="rounded-full bg-background px-1.5 py-0.5 text-[10px] capitalize">
                {e.status}
              </span>
              {e.enrolledAt && (
                <span>{format(new Date(e.enrolledAt), "MMM d, yyyy")}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    );

  return (
    <div data-testid="lms-enrollments">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex flex-1 items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground"
        >
          <GraduationCap className="h-3 w-3" />
          <span className="flex-1 text-left">{t("title")}</span>
          <ChevronDown
            className={cn("h-3 w-3 transition-transform", !open && "-rotate-90")}
          />
        </button>
        {open && (
          <button
            type="button"
            onClick={() => refresh()}
            disabled={loading}
            aria-label={t("refresh")}
            title={t("refresh")}
            className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
          </button>
        )}
      </div>

      {open && (
        <div className="mt-2 space-y-3">
          {loading ? (
            <div data-testid="lms-skeleton" className="space-y-2" aria-busy="true">
              <div className="h-12 animate-pulse rounded-lg bg-muted" />
              <div className="h-12 animate-pulse rounded-lg bg-muted" />
            </div>
          ) : error ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            >
              <div className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{t(`errors.${errorKey}`)}</span>
              </div>
              {errorKey !== "misconfigured" && (
                <button
                  type="button"
                  onClick={() => refresh()}
                  className="mt-1 font-medium underline"
                >
                  {t("retry")}
                </button>
              )}
            </div>
          ) : data && data.enrollments.length === 0 ? (
            <p className="px-1 text-xs text-muted-foreground">{t("empty")}</p>
          ) : data ? (
            <>
              {renderGroup(
                "course",
                data.enrollments.filter((e) => e.kind === "course"),
              )}
              {renderGroup(
                "webinar",
                data.enrollments.filter((e) => e.kind === "webinar"),
              )}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
