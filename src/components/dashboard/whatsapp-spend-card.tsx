'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Settings2 } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createClient } from '@/lib/supabase/client'
import { browserTimeZone } from '@/lib/dashboard/overview'
import {
  DEFAULT_RATE_CARD,
  lastLocalDays,
  loadRateCard,
  loadSpendRows,
  saveRateCard,
  summarizeSpend,
  type RateCard,
  type SpendDailyRow,
} from '@/lib/dashboard/whatsapp-spend'
import { Skeleton } from './skeleton'
import { Sparkline } from './sparkline'

/**
 * Approximate Meta messaging spend for the selected dashboard range.
 * Admin-only: the page renders it only for admins, and the data
 * behind it (RLS + whatsapp_spend_daily) is admin-only too.
 */
export function WhatsAppSpendCard({
  accountId,
  days,
}: {
  accountId: string
  days: number
}) {
  const t = useTranslations('Dashboard.overview.spend')
  const format = useFormatter()

  const [rows, setRows] = useState<SpendDailyRow[] | null>(null)
  const [rates, setRates] = useState<RateCard | null>(null)
  const [failed, setFailed] = useState(false)
  const [editing, setEditing] = useState(false)
  const request = useRef(0)

  const load = useCallback(() => {
    const id = ++request.current
    const supabase = createClient()
    Promise.all([
      loadSpendRows(supabase, days, browserTimeZone()),
      loadRateCard(supabase, accountId),
    ])
      .then(([r, card]) => {
        if (id !== request.current) return
        setRows(r)
        setRates(card)
        setFailed(false)
      })
      .catch((err) => {
        if (id !== request.current) return
        console.error('[dashboard] spend failed:', err)
        setFailed(true)
      })
  }, [accountId, days])

  useEffect(() => {
    load()
  }, [load])

  const summary = useMemo(
    () =>
      rows && rates
        ? summarizeSpend(rows, rates, lastLocalDays(days, browserTimeZone()))
        : null,
    [rows, rates, days],
  )

  const money = (value: number, currency: string) =>
    format.number(value, { style: 'currency', currency, maximumFractionDigits: 2 })
  // Per-message rates are fractions of a rupee (e.g. ₹0.8631): keep the precision.
  const rate = (value: number, currency: string) =>
    format.number(value, { style: 'currency', currency, maximumFractionDigits: 4 })

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description', { days })}</CardDescription>
        <CardAction>
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)} disabled={!rates}>
            <Settings2 className="mr-1 size-3.5" aria-hidden />
            {t('editRates')}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {failed ? (
          <p className="text-sm text-muted-foreground">{t('unavailable')}</p>
        ) : !summary || !rates ? (
          <Skeleton className="h-44 w-full" />
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <p className="text-2xl font-semibold tabular-nums text-foreground">
                  {money(summary.total, rates.currency)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('beforeTax', {
                    amount: money(summary.subtotal, rates.currency),
                    percent: format.number(rates.tax_percent),
                  })}
                </p>
              </div>
              <p className="text-right text-xs text-muted-foreground">
                {t('billableMessages', { count: summary.messages })}
              </p>
            </div>

            <div className="mt-2">
              <Sparkline values={summary.daily.map((d) => d.cost)} />
            </div>

            <ul className="mt-2 divide-y divide-border border-t border-border">
              {summary.categories.map((c) => (
                <li key={c.category} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-foreground">{t(`categories.${c.category}`)}</span>
                  <span className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                    {t('perMessage', {
                      count: c.messages,
                      rate: rate(rates[c.category], rates.currency),
                    })}
                  </span>
                  <span className="w-20 shrink-0 text-right font-medium tabular-nums text-foreground">
                    {money(c.cost, rates.currency)}
                  </span>
                </li>
              ))}
            </ul>

            <p className="mt-2 text-xs text-muted-foreground">
              {summary.estimatedMessages > 0
                ? t('noteEstimated', {
                    tracked: summary.trackedMessages,
                    estimated: summary.estimatedMessages,
                  })
                : t('noteTracked')}
            </p>
          </>
        )}
      </CardContent>

      {rates && (
        <RateCardDialog
          open={editing}
          onOpenChange={setEditing}
          initial={rates}
          onSave={async (next) => {
            await saveRateCard(createClient(), accountId, next)
            setRates(next)
          }}
        />
      )}
    </Card>
  )
}

const RATE_FIELDS = ['marketing', 'utility', 'authentication', 'tax_percent'] as const

function RateCardDialog({
  open,
  onOpenChange,
  initial,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initial: RateCard
  onSave: (rates: RateCard) => Promise<void>
}) {
  const t = useTranslations('Dashboard.overview.spend')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  // Re-seed the form from the saved card each time the dialog opens.
  const [seededFor, setSeededFor] = useState(false)
  if (open !== seededFor) {
    setSeededFor(open)
    if (open) {
      setDraft({
        currency: initial.currency,
        ...Object.fromEntries(RATE_FIELDS.map((f) => [f, String(initial[f])])),
      })
    }
  }

  const parsed = RATE_FIELDS.map((f) => Number(draft[f]))
  const currency = (draft.currency ?? '').trim().toUpperCase()
  const valid =
    /^[A-Z]{3}$/.test(currency) &&
    parsed.every((n) => Number.isFinite(n) && n >= 0) &&
    Number(draft.tax_percent) <= 100

  async function handleSave() {
    if (!valid) return
    setSaving(true)
    try {
      await onSave({
        currency,
        marketing: Number(draft.marketing),
        utility: Number(draft.utility),
        authentication: Number(draft.authentication),
        tax_percent: Number(draft.tax_percent),
      })
      toast.success(t('ratesSaved'))
      onOpenChange(false)
    } catch (err) {
      console.error('Failed to save rate card:', err)
      toast.error(t('ratesSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('ratesTitle')}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">{t('ratesHelp')}</p>
        <div className="grid grid-cols-2 gap-3 py-1">
          <div className="col-span-2">
            <Label htmlFor="rate-currency" className="text-xs text-muted-foreground">
              {t('currency')}
            </Label>
            <Input
              id="rate-currency"
              value={draft.currency ?? ''}
              maxLength={3}
              onChange={(e) => setDraft((d) => ({ ...d, currency: e.target.value }))}
              className="mt-1"
            />
          </div>
          {RATE_FIELDS.map((field) => (
            <div key={field}>
              <Label htmlFor={`rate-${field}`} className="text-xs text-muted-foreground">
                {field === 'tax_percent' ? t('taxPercent') : t(`categories.${field}`)}
              </Label>
              <Input
                id={`rate-${field}`}
                type="number"
                inputMode="decimal"
                min={0}
                step="0.0001"
                value={draft[field] ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, [field]: e.target.value }))}
                className="mt-1"
              />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() =>
              setDraft({
                currency: DEFAULT_RATE_CARD.currency,
                ...Object.fromEntries(RATE_FIELDS.map((f) => [f, String(DEFAULT_RATE_CARD[f])])),
              })
            }
          >
            {t('resetDefaults')}
          </Button>
          <Button onClick={handleSave} disabled={!valid || saving}>
            {saving && <Loader2 className="mr-1 size-3.5 animate-spin" />}
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
