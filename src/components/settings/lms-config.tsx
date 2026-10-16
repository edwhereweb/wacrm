'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/use-auth';
import { lmsEnrollmentsCache } from '@/hooks/use-lms-enrollments';
import { SettingsPanelHead } from './settings-panel-head';

export function LmsConfig() {
  const { canEditSettings } = useAuth();
  const t = useTranslations('Settings.lms');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/integrations/lms/config');
      const body = await res.json();
      if (!res.ok) throw new Error();
      setBaseUrl(body.base_url ?? '');
      setHasKey(!!body.has_key);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch('/api/integrations/lms/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_url: baseUrl,
          ...(apiKey.trim() ? { api_key: apiKey } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? t('saveFailed'));
        return;
      }
      toast.success(t('saved'));
      setApiKey('');
      setHasKey(true);
      // Config changed — cached enrollments may be from the old LMS.
      lmsEnrollmentsCache.clear();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('description')} />
      <Card>
        <CardContent className="p-5">
          {loading ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : (
            <form onSubmit={save} className="max-w-lg space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="lms-base-url">{t('baseUrl')}</Label>
                <Input
                  id="lms-base-url"
                  type="url"
                  required
                  placeholder="https://lms.example.com"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  disabled={!canEditSettings}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lms-api-key">{t('apiKey')}</Label>
                <Input
                  id="lms-api-key"
                  type="password"
                  autoComplete="off"
                  required={!hasKey}
                  placeholder={hasKey ? t('keyPlaceholder') : ''}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  disabled={!canEditSettings}
                />
                <p className="text-xs text-muted-foreground">{t('keyHint')}</p>
              </div>
              {canEditSettings ? (
                <Button type="submit" disabled={saving}>
                  {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
                  {t('save')}
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">{t('adminOnly')}</p>
              )}
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
