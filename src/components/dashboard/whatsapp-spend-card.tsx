'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Plus, Settings2, X } from 'lucide-react'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { createClient } from '@/lib/supabase/client'
import { browserTimeZone } from '@/lib/dashboard/overview'
import {
  DEFAULT_RATE_CARD,
  MAX_RANGE_DAYS,
  daysBetween,
  isValidRange,
  loadCountryRates,
  loadRateCard,
  loadSpendRows,
  presetRange,
  saveCountryRates,
  saveRateCard,
  summarizeSpend,
  type CountryRate,
  type RateCard,
  type SpendDailyRow,
  type SpendRange,
} from '@/lib/dashboard/whatsapp-spend'
import { PRICING_COUNTRY_CODES } from '@/lib/whatsapp/pricing-countries'
import { Skeleton } from './skeleton'
import { Sparkline } from './sparkline'

const PRESETS = ['dashboard', 'thisMonth', 'lastMonth', 'custom'] as const
type Preset = (typeof PRESETS)[number]

/** Country name in the viewer's language; "US" covers the whole +1 zone. */
function useCountryName() {
  const locale = useLocale()
  const t = useTranslations('Dashboard.overview.spend')
  const names = useMemo(() => {
    try {
      return new Intl.DisplayNames([locale], { type: 'region' })
    } catch {
      return null
    }
  }, [locale])
  return useCallback(
    (code: string | null) => {
      if (!code) return t('unknownCountry')
      if (code === 'US') return t('northAmerica')
      return names?.of(code) ?? code
    },
    [names, t],
  )
}

/**
 * Approximate Meta messaging spend, priced by recipient country, for
 * the dashboard's range or a range the admin picks. Admin-only: the
 * page renders it only for admins, and the data behind it (RLS +
 * whatsapp_spend_range) is admin-only too.
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
  const countryName = useCountryName()

  const [preset, setPreset] = useState<Preset>('dashboard')
  const [custom, setCustom] = useState<SpendRange>(() => presetRange('lastDays', browserTimeZone(), days))
  const range = useMemo<SpendRange>(() => {
    const tz = browserTimeZone()
    if (preset === 'dashboard') return presetRange('lastDays', tz, days)
    if (preset === 'custom') return custom
    return presetRange(preset, tz)
  }, [preset, custom, days])
  const rangeOk = isValidRange(range)

  const [rows, setRows] = useState<SpendDailyRow[] | null>(null)
  const [loadedRange, setLoadedRange] = useState<SpendRange | null>(null)
  const [rates, setRates] = useState<RateCard | null>(null)
  const [countryRates, setCountryRates] = useState<CountryRate[]>([])
  const [failed, setFailed] = useState(false)
  const [editing, setEditing] = useState(false)
  const request = useRef(0)

  const load = useCallback(() => {
    if (!isValidRange(range)) return
    const id = ++request.current
    const supabase = createClient()
    Promise.all([
      loadSpendRows(supabase, range, browserTimeZone()),
      loadRateCard(supabase, accountId),
      loadCountryRates(supabase, accountId),
    ])
      .then(([r, card, byCountry]) => {
        if (id !== request.current) return
        setRows(r)
        setLoadedRange(range)
        setRates(card)
        setCountryRates(byCountry)
        setFailed(false)
      })
      .catch((err) => {
        if (id !== request.current) return
        console.error('[dashboard] spend failed:', err)
        setFailed(true)
      })
  }, [accountId, range])

  useEffect(() => {
    load()
  }, [load])

  const loading =
    !loadedRange || loadedRange.from !== range.from || loadedRange.to !== range.to

  const summary = useMemo(
    () =>
      rows && rates && loadedRange
        ? summarizeSpend(rows, rates, daysBetween(loadedRange.from, loadedRange.to), countryRates)
        : null,
    [rows, rates, loadedRange, countryRates],
  )

  const money = (value: number, currency: string) =>
    format.number(value, { style: 'currency', currency, maximumFractionDigits: 2 })
  const shortDate = (day: string) =>
    format.dateTime(new Date(`${day}T00:00:00`), { day: 'numeric', month: 'short', year: 'numeric' })

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>
          {preset === 'dashboard'
            ? t('description', { days })
            : t('descriptionRange', { from: shortDate(range.from), to: shortDate(range.to) })}
        </CardDescription>
        <CardAction>
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)} disabled={!rates}>
            <Settings2 className="mr-1 size-3.5" aria-hidden />
            {t('editRates')}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <Select value={preset} onValueChange={(v) => setPreset(v as Preset)}>
            <SelectTrigger size="sm" className="w-40" aria-label={t('rangeLabel')}>
              <SelectValue>{(v: Preset) => t(`presets.${v}`, { days })}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {PRESETS.map((p) => (
                <SelectItem key={p} value={p}>
                  {t(`presets.${p}`, { days })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {preset === 'custom' && (
            <>
              <Label className="sr-only" htmlFor="spend-from">
                {t('from')}
              </Label>
              <Input
                id="spend-from"
                type="date"
                value={custom.from}
                max={custom.to}
                onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
                className="h-7 w-36"
              />
              <span className="pb-1 text-xs text-muted-foreground">–</span>
              <Label className="sr-only" htmlFor="spend-to">
                {t('to')}
              </Label>
              <Input
                id="spend-to"
                type="date"
                value={custom.to}
                min={custom.from}
                onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
                className="h-7 w-36"
              />
            </>
          )}
        </div>

        {!rangeOk ? (
          <p className="text-sm text-muted-foreground">{t('invalidRange', { max: MAX_RANGE_DAYS })}</p>
        ) : failed ? (
          <p className="text-sm text-muted-foreground">{t('unavailable')}</p>
        ) : !summary || !rates ? (
          <Skeleton className="h-44 w-full" />
        ) : (
          <div className={loading ? 'opacity-60 transition-opacity' : undefined} aria-busy={loading}>
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
                    {t('messagesCount', { count: c.messages })}
                  </span>
                  <span className="w-20 shrink-0 text-right font-medium tabular-nums text-foreground">
                    {money(c.cost, rates.currency)}
                  </span>
                </li>
              ))}
            </ul>

            {summary.countries.length > 0 && (
              <div className="mt-3">
                <p className="text-xs font-medium text-muted-foreground">{t('byCountry')}</p>
                <ul className="mt-1 max-h-40 divide-y divide-border overflow-y-auto">
                  {summary.countries.map((c) => (
                    <li key={c.country ?? 'unknown'} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                      <span className="min-w-0 flex-1 truncate text-foreground">
                        {countryName(c.country)}
                        {!c.customRates && (
                          <span className="ml-1.5 text-xs text-muted-foreground">{t('defaultRateTag')}</span>
                        )}
                      </span>
                      <span className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                        {t('messagesCount', { count: c.messages })}
                      </span>
                      <span className="w-20 shrink-0 text-right font-medium tabular-nums text-foreground">
                        {money(c.cost, rates.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p className="mt-2 text-xs text-muted-foreground">
              {summary.estimatedMessages > 0
                ? t('noteEstimated', {
                    tracked: summary.trackedMessages,
                    estimated: summary.estimatedMessages,
                  })
                : t('noteTracked')}
            </p>
          </div>
        )}
      </CardContent>

      {rates && (
        <RateCardDialog
          open={editing}
          onOpenChange={setEditing}
          initial={rates}
          initialCountries={countryRates}
          suggested={
            summary?.countries
              .filter((c) => c.country && !c.customRates)
              .map((c) => c.country as string) ?? []
          }
          onSave={async (next, nextCountries) => {
            const supabase = createClient()
            await saveRateCard(supabase, accountId, next)
            await saveCountryRates(supabase, accountId, nextCountries)
            setRates(next)
            setCountryRates(nextCountries)
          }}
        />
      )}
    </Card>
  )
}

const RATE_FIELDS = ['marketing', 'utility', 'authentication', 'tax_percent'] as const
const COUNTRY_FIELDS = ['marketing', 'utility', 'authentication'] as const

type CountryDraft = { country: string } & Record<(typeof COUNTRY_FIELDS)[number], string>

function isRate(value: string): boolean {
  const n = Number(value)
  return value.trim() !== '' && Number.isFinite(n) && n >= 0
}

function RateCardDialog({
  open,
  onOpenChange,
  initial,
  initialCountries,
  suggested,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initial: RateCard
  initialCountries: CountryRate[]
  /** Countries in the current spend that still use the default rates. */
  suggested: string[]
  onSave: (rates: RateCard, countries: CountryRate[]) => Promise<void>
}) {
  const t = useTranslations('Dashboard.overview.spend')
  const countryName = useCountryName()
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [countries, setCountries] = useState<CountryDraft[]>([])
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
      setCountries(
        initialCountries.map((c) => ({
          country: c.country,
          marketing: String(c.marketing),
          utility: String(c.utility),
          authentication: String(c.authentication),
        })),
      )
    }
  }

  const used = new Set(countries.map((c) => c.country))
  const sortedCodes = useMemo(
    () => [...PRICING_COUNTRY_CODES].sort((a, b) => countryName(a).localeCompare(countryName(b))),
    [countryName],
  )

  function addCountry() {
    // Start with a country we are already messaging, else the first free one.
    const next = suggested.find((c) => !used.has(c)) ?? sortedCodes.find((c) => !used.has(c))
    if (!next) return
    setCountries((list) => [
      ...list,
      {
        country: next,
        marketing: draft.marketing ?? '',
        utility: draft.utility ?? '',
        authentication: draft.authentication ?? '',
      },
    ])
  }

  const currency = (draft.currency ?? '').trim().toUpperCase()
  const valid =
    /^[A-Z]{3}$/.test(currency) &&
    RATE_FIELDS.every((f) => isRate(draft[f] ?? '')) &&
    Number(draft.tax_percent) <= 100 &&
    countries.every((c) => COUNTRY_FIELDS.every((f) => isRate(c[f]))) &&
    used.size === countries.length

  async function handleSave() {
    if (!valid) return
    setSaving(true)
    try {
      await onSave(
        {
          currency,
          marketing: Number(draft.marketing),
          utility: Number(draft.utility),
          authentication: Number(draft.authentication),
          tax_percent: Number(draft.tax_percent),
        },
        countries.map((c) => ({
          country: c.country,
          marketing: Number(c.marketing),
          utility: Number(c.utility),
          authentication: Number(c.authentication),
        })),
      )
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('ratesTitle')}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">{t('ratesHelp')}</p>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
          <div className="col-span-2">
            <Label htmlFor="rate-tax_percent" className="text-xs text-muted-foreground">
              {t('taxPercent')}
            </Label>
            <Input
              id="rate-tax_percent"
              type="number"
              inputMode="decimal"
              min={0}
              max={100}
              step="0.01"
              value={draft.tax_percent ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, tax_percent: e.target.value }))}
              className="mt-1"
            />
          </div>
        </div>

        <div>
          <p className="text-xs font-medium text-foreground">{t('defaultRates')}</p>
          <p className="text-xs text-muted-foreground">{t('defaultRatesHelp')}</p>
          <div className="mt-2 grid grid-cols-3 gap-3">
            {COUNTRY_FIELDS.map((field) => (
              <div key={field}>
                <Label htmlFor={`rate-${field}`} className="text-xs text-muted-foreground">
                  {t(`categories.${field}`)}
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
        </div>

        <div>
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-xs font-medium text-foreground">{t('countryRates')}</p>
              <p className="text-xs text-muted-foreground">{t('countryRatesHelp')}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={addCountry}
              disabled={used.size >= PRICING_COUNTRY_CODES.length}
            >
              <Plus className="mr-1 size-3.5" aria-hidden />
              {t('addCountry')}
            </Button>
          </div>
          {countries.length > 0 && (
            <div className="mt-2 space-y-2">
              <div className="hidden grid-cols-[minmax(0,1.6fr)_repeat(3,minmax(0,1fr))_2rem] gap-2 text-xs text-muted-foreground sm:grid">
                <span>{t('country')}</span>
                {COUNTRY_FIELDS.map((f) => (
                  <span key={f}>{t(`categories.${f}`)}</span>
                ))}
                <span />
              </div>
              {countries.map((row, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[repeat(3,minmax(0,1fr))_2rem] gap-2 sm:grid-cols-[minmax(0,1.6fr)_repeat(3,minmax(0,1fr))_2rem]"
                >
                  <select
                    aria-label={t('country')}
                    value={row.country}
                    onChange={(e) =>
                      setCountries((list) =>
                        list.map((c, j) => (j === i ? { ...c, country: e.target.value } : c)),
                      )
                    }
                    className="col-span-4 h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:col-span-1 dark:bg-input/30"
                  >
                    {sortedCodes
                      .filter((code) => code === row.country || !used.has(code))
                      .map((code) => (
                        <option key={code} value={code}>
                          {countryName(code)}
                        </option>
                      ))}
                  </select>
                  {COUNTRY_FIELDS.map((field) => (
                    <Input
                      key={field}
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="0.0001"
                      aria-label={`${countryName(row.country)} ${t(`categories.${field}`)}`}
                      placeholder={t(`categories.${field}`)}
                      value={row[field]}
                      onChange={(e) =>
                        setCountries((list) =>
                          list.map((c, j) => (j === i ? { ...c, [field]: e.target.value } : c)),
                        )
                      }
                    />
                  ))}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-label={t('removeCountry', { country: countryName(row.country) })}
                    onClick={() => setCountries((list) => list.filter((_, j) => j !== i))}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
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
