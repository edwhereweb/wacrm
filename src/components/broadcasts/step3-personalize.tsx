'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Contact, CustomField, MessageTemplate, TemplateButton } from '@/types';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  CornerDownLeft,
  ExternalLink,
  Eye,
  ImageIcon,
  Link2,
  Loader2,
  Phone,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

export type VariableType = 'static' | 'field' | 'custom_field';

export interface VariableMapping {
  type: VariableType;
  value: string;
}

export interface ButtonParamSlot {
  index: number;
  button: TemplateButton;
  type: 'URL' | 'COPY_CODE';
  label: string;
  url?: string;
  example?: string;
  required: boolean;
}

interface Step3Props {
  template: MessageTemplate;
  variables: Record<string, VariableMapping>;
  onUpdate: (variables: Record<string, VariableMapping>) => void;
  buttonVariables?: Record<number, VariableMapping>;
  onButtonVariablesChange?: (
    buttonVariables: Record<number, VariableMapping>,
  ) => void;
  /** Media URL for an IMAGE/VIDEO/DOCUMENT header, when the template has one. */
  headerMediaUrl: string;
  onHeaderMediaUrlChange: (url: string) => void;
  onNext: () => void;
  onBack: () => void;
}

const MEDIA_HEADER_TYPES = ['image', 'video', 'document'] as const;
type MediaHeaderType = (typeof MEDIA_HEADER_TYPES)[number];

function isMediaHeaderType(value: unknown): value is MediaHeaderType {
  return MEDIA_HEADER_TYPES.includes(value as MediaHeaderType);
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const contactFields = [
  { value: 'name', labelKey: 'name' },
  { value: 'phone', labelKey: 'phone' },
  { value: 'email', labelKey: 'email' },
];

const SAMPLE_CONTACT: Contact = {
  id: 'sample',
  user_id: '',
  account_id: '',
  name: 'John Doe',
  phone: '+1234567890',
  email: 'john@example.com',
  company: 'Acme Corp',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

export function Step3Personalize({
  template,
  variables,
  onUpdate,
  buttonVariables = {},
  onButtonVariablesChange,
  headerMediaUrl,
  onHeaderMediaUrlChange,
  onNext,
  onBack,
}: Step3Props) {
  const t = useTranslations('Broadcasts.wizard');
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingFields, setLoadingFields] = useState(true);
  const [firstContact, setFirstContact] = useState<Contact | null>(null);
  const [firstContactCustomValues, setFirstContactCustomValues] = useState<
    Map<string, string>
  >(new Map());
  const [loadingPreview, setLoadingPreview] = useState(true);

  // Load user's custom fields + a representative contact for the
  // live preview. Fall back to sample data if no contacts exist yet.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const [fieldsRes, contactRes] = await Promise.all([
        supabase.from('custom_fields').select('*').order('field_name'),
        supabase
          .from('contacts')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (cancelled) return;

      setCustomFields(fieldsRes.data ?? []);
      setLoadingFields(false);

      const contact = contactRes.data ?? null;
      setFirstContact(contact);

      if (contact) {
        const { data: customVals } = await supabase
          .from('contact_custom_values')
          .select('custom_field_id, value')
          .eq('contact_id', contact.id);
        if (!cancelled) {
          const map = new Map<string, string>();
          for (const row of customVals ?? []) {
            map.set(row.custom_field_id, row.value ?? '');
          }
          setFirstContactCustomValues(map);
        }
      }
      setLoadingPreview(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const placeholders = useMemo(() => {
    const matches = template.body_text.match(/\{\{(\d+)\}\}/g);
    if (!matches) return [];
    return [...new Set(matches)].sort();
  }, [template.body_text]);

  // Identify any template buttons that require or accept dynamic parameters
  // (e.g. dynamic URL button with {{1}} or COPY_CODE button).
  const buttonSlots = useMemo<ButtonParamSlot[]>(() => {
    if (!template.buttons || template.buttons.length === 0) return [];
    const slots: ButtonParamSlot[] = [];

    template.buttons.forEach((btn, index) => {
      if (btn.type === 'URL') {
        const vars = extractVariableIndices(btn.url);
        if (vars.length > 0) {
          slots.push({
            index,
            button: btn,
            type: 'URL',
            label: btn.text,
            url: btn.url,
            example: btn.example,
            required: true,
          });
        }
      } else if (btn.type === 'COPY_CODE') {
        slots.push({
          index,
          button: btn,
          type: 'COPY_CODE',
          label: btn.text,
          example: btn.example,
          required: false,
        });
      }
    });

    return slots;
  }, [template.buttons]);

  // Templates with an IMAGE/VIDEO/DOCUMENT header need a media URL at
  // send time — Meta requires the media component on every delivery and
  // rejects the broadcast without it. The field is hidden for text-only
  // headers.
  const mediaHeaderType = isMediaHeaderType(template.header_type)
    ? template.header_type
    : null;

  // Seed the field with the template's stored sample URL the first time
  // we land on a media-header template, so the common "reuse the
  // approved media" case needs no typing. Only seeds when empty to avoid
  // clobbering a URL the user already edited.
  useEffect(() => {
    if (mediaHeaderType && !headerMediaUrl && template.header_media_url) {
      onHeaderMediaUrlChange(template.header_media_url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaHeaderType, template.header_media_url]);

  const headerMediaError = useMemo<'missing' | 'invalid' | null>(() => {
    if (!mediaHeaderType) return null;
    const value = headerMediaUrl.trim();
    if (!value) return 'missing';
    if (!isValidHttpUrl(value)) return 'invalid';
    return null;
  }, [mediaHeaderType, headerMediaUrl]);

  /**
   * A placeholder is "unmapped" if the user hasn't picked either a
   * static value or a field/custom-field source. Blocks Next until
   * every placeholder has something — otherwise the broadcast would
   * ship with empty strings and confuse recipients.
   */
  const unmappedKeys = useMemo(() => {
    const missing: string[] = [];
    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^\{\{|\}\}$/g, '');
      const mapping = variables[key];
      if (!mapping || !mapping.value?.trim()) {
        missing.push(placeholder);
      }
    }
    return missing;
  }, [placeholders, variables]);

  const unmappedButtonKeys = useMemo(() => {
    const missing: string[] = [];
    for (const slot of buttonSlots) {
      if (slot.required) {
        const mapping = buttonVariables[slot.index];
        if (!mapping || !mapping.value?.trim()) {
          missing.push(`Button "${slot.label}"`);
        }
      }
    }
    return missing;
  }, [buttonSlots, buttonVariables]);

  const allUnmapped = useMemo(() => {
    return [...unmappedKeys, ...unmappedButtonKeys];
  }, [unmappedKeys, unmappedButtonKeys]);

  function updateVariable(key: string, patch: Partial<VariableMapping>) {
    const current = variables[key] ?? {
      type: 'static' as VariableType,
      value: '',
    };
    onUpdate({
      ...variables,
      [key]: { ...current, ...patch },
    });
  }

  function updateButtonVariable(
    index: number,
    patch: Partial<VariableMapping>,
  ) {
    const current = buttonVariables[index] ?? {
      type: 'static' as VariableType,
      value: '',
    };
    onButtonVariablesChange?.({
      ...buttonVariables,
      [index]: { ...current, ...patch },
    });
  }

  function resolveButtonPreviewValue(slotIndex: number): string {
    const mapping = buttonVariables[slotIndex];
    const contact = firstContact ?? SAMPLE_CONTACT;
    const customValues = firstContact
      ? firstContactCustomValues
      : new Map<string, string>();

    if (mapping) {
      if (mapping.type === 'static' && mapping.value) {
        return mapping.value;
      } else if (mapping.type === 'field' && mapping.value) {
        const fieldMap: Record<string, string | undefined> = {
          name: contact.name,
          phone: contact.phone,
          email: contact.email,
          company: contact.company,
        };
        return fieldMap[mapping.value] ?? '';
      } else if (mapping.type === 'custom_field' && mapping.value) {
        return customValues.get(mapping.value) ?? '';
      }
    }
    return '';
  }

  /**
   * Substitute placeholders using the first real contact where
   * possible. Placeholders keyed by "{{N}}" map to variable key "N".
   */
  const previewText = useMemo(() => {
    const contact = firstContact ?? SAMPLE_CONTACT;
    const customValues = firstContact
      ? firstContactCustomValues
      : new Map<string, string>();

    let text = template.body_text;
    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^\{\{|\}\}$/g, '');
      const mapping = variables[key];
      let replacement = placeholder;

      if (mapping) {
        if (mapping.type === 'static' && mapping.value) {
          replacement = mapping.value;
        } else if (mapping.type === 'field' && mapping.value) {
          const fieldMap: Record<string, string | undefined> = {
            name: contact.name,
            phone: contact.phone,
            email: contact.email,
            company: contact.company,
          };
          replacement = fieldMap[mapping.value] ?? placeholder;
        } else if (mapping.type === 'custom_field' && mapping.value) {
          replacement = customValues.get(mapping.value) || placeholder;
        }
      }
      text = text.replaceAll(placeholder, replacement);
    }
    return text;
  }, [
    template.body_text,
    variables,
    placeholders,
    firstContact,
    firstContactCustomValues,
  ]);

  const previewLabel = firstContact
    ? firstContact.name || firstContact.phone
    : t('personalize.previewSample');

  const hasNoInputs =
    placeholders.length === 0 && !mediaHeaderType && buttonSlots.length === 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          {t('personalize.title')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('personalize.subtitle')}
        </p>
      </div>

      {/* Media Header URL */}
      {mediaHeaderType && (
        <div className="rounded-xl border border-border bg-card/50 p-4">
          <div className="mb-3 flex items-center gap-2">
            <ImageIcon className="h-4 w-4 text-primary" />
            <p className="text-sm font-medium text-foreground">
              {t('personalize.headerImage')}
            </p>
            <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium uppercase text-primary">
              {mediaHeaderType}
            </span>
          </div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            {t('personalize.imageUrl')}
          </label>
          <Input
            type="url"
            value={headerMediaUrl}
            onChange={(e) => onHeaderMediaUrlChange(e.target.value)}
            placeholder={t('personalize.imageUrlPlaceholder')}
            className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t('personalize.headerImageDesc')}
          </p>
          {mediaHeaderType === 'image' &&
            headerMediaError === null &&
            headerMediaUrl.trim() && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={headerMediaUrl.trim()}
                alt={t('personalize.headerPreviewAlt')}
                className="mt-3 max-h-40 rounded-lg border border-border object-contain"
              />
            )}
          {headerMediaError && (
            <p className="mt-1.5 text-xs text-amber-300">
              {headerMediaError === 'missing'
                ? t('personalize.mediaUrlRequired')
                : t('personalize.mediaUrlInvalid')}
            </p>
          )}
        </div>
      )}

      {hasNoInputs ? (
        <div className="rounded-xl border border-border bg-card/50 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            {t('personalize.noPreview')}
          </p>
        </div>
      ) : null}

      {/* Body Variables */}
      {placeholders.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('personalize.variables')}
            </span>
          </div>
          {placeholders.map((placeholder) => {
            const key = placeholder.replace(/^\{\{|\}\}$/g, '');
            const mapping = variables[key] ?? { type: 'static', value: '' };

            return (
              <div
                key={placeholder}
                className="rounded-xl border border-border bg-card/50 p-4"
              >
                <div className="mb-3 flex items-center gap-2">
                  <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-xs font-mono font-medium text-primary">
                    {placeholder}
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                      {t('personalize.type')}
                    </label>
                    <Select
                      value={mapping.type}
                      onValueChange={(val) =>
                        updateVariable(key, {
                          type: val as VariableType,
                          value: '',
                        })
                      }
                    >
                      <SelectTrigger className="w-full border-border bg-muted text-foreground">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="border-border bg-popover">
                        <SelectItem value="static">
                          {t('personalize.typeStatic')}
                        </SelectItem>
                        <SelectItem value="field">
                          {t('personalize.typeContact')}
                        </SelectItem>
                        <SelectItem value="custom_field">
                          {t('personalize.typeCustom')}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                      {mapping.type === 'static'
                        ? t('personalize.staticValue')
                        : t('personalize.contactField')}
                    </label>
                    {mapping.type === 'static' ? (
                      <Input
                        value={mapping.value}
                        onChange={(e) =>
                          updateVariable(key, { value: e.target.value })
                        }
                        placeholder={t('personalize.enterValue')}
                        className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                      />
                    ) : mapping.type === 'field' ? (
                      <Select
                        value={mapping.value || undefined}
                        onValueChange={(val) =>
                          updateVariable(key, { value: val || '' })
                        }
                      >
                        <SelectTrigger className="w-full border-border bg-muted text-foreground">
                          <SelectValue
                            placeholder={t('personalize.selectContactField')}
                          />
                        </SelectTrigger>
                        <SelectContent className="border-border bg-popover">
                          {contactFields.map((field) => (
                            <SelectItem key={field.value} value={field.value}>
                              {t(`personalize.fieldMap.${field.labelKey}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Select
                        value={mapping.value || undefined}
                        onValueChange={(val) =>
                          updateVariable(key, { value: val || '' })
                        }
                      >
                        <SelectTrigger className="w-full border-border bg-muted text-foreground">
                          <SelectValue
                            placeholder={
                              loadingFields
                                ? t('personalize.loadingFields')
                                : customFields.length === 0
                                  ? t('personalize.noCustomFields')
                                  : t('personalize.selectCustomField')
                            }
                          />
                        </SelectTrigger>
                        <SelectContent className="border-border bg-popover">
                          {customFields.map((f) => (
                            <SelectItem key={f.id} value={f.id}>
                              {f.field_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Button Parameters */}
      {buttonSlots.length > 0 && (
        <div className="space-y-4">
          <div>
            <div className="flex items-center gap-2">
              <Link2 className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold text-foreground">
                {t('personalize.buttonParameters')}
              </h3>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('personalize.buttonParamDesc')}
            </p>
          </div>

          {buttonSlots.map((slot) => {
            const mapping = buttonVariables[slot.index] ?? {
              type: 'static',
              value: '',
            };
            const sampleVal = resolveButtonPreviewValue(slot.index);

            return (
              <div
                key={`button-param-${slot.index}`}
                className="rounded-xl border border-border bg-card/50 p-4 transition-colors"
              >
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {slot.type === 'URL' ? (
                      <ExternalLink className="h-4 w-4 text-primary" />
                    ) : (
                      <Copy className="h-4 w-4 text-primary" />
                    )}
                    <span className="text-sm font-medium text-foreground">
                      {slot.label}
                    </span>
                    <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-xs font-mono font-medium text-primary">
                      {slot.type === 'URL' ? 'URL {{1}}' : 'COPY CODE'}
                    </span>
                  </div>
                  {slot.required && (
                    <span className="text-[11px] font-medium text-amber-400">
                      {t('personalize.buttonRequired')}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                      {t('personalize.type')}
                    </label>
                    <Select
                      value={mapping.type}
                      onValueChange={(val) =>
                        updateButtonVariable(slot.index, {
                          type: val as VariableType,
                          value: '',
                        })
                      }
                    >
                      <SelectTrigger className="w-full border-border bg-muted text-foreground">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="border-border bg-popover">
                        <SelectItem value="static">
                          {t('personalize.typeStatic')}
                        </SelectItem>
                        <SelectItem value="field">
                          {t('personalize.typeContact')}
                        </SelectItem>
                        <SelectItem value="custom_field">
                          {t('personalize.typeCustom')}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                      {mapping.type === 'static'
                        ? t('personalize.staticValue')
                        : t('personalize.contactField')}
                    </label>
                    {mapping.type === 'static' ? (
                      <Input
                        value={mapping.value}
                        onChange={(e) =>
                          updateButtonVariable(slot.index, {
                            value: e.target.value,
                          })
                        }
                        placeholder={
                          slot.type === 'URL'
                            ? slot.example || t('personalize.enterValue')
                            : slot.example
                              ? t('personalize.defaultCode', {
                                  code: slot.example,
                                })
                              : t('personalize.enterValue')
                        }
                        className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                      />
                    ) : mapping.type === 'field' ? (
                      <Select
                        value={mapping.value || undefined}
                        onValueChange={(val) =>
                          updateButtonVariable(slot.index, {
                            value: val || '',
                          })
                        }
                      >
                        <SelectTrigger className="w-full border-border bg-muted text-foreground">
                          <SelectValue
                            placeholder={t('personalize.selectContactField')}
                          />
                        </SelectTrigger>
                        <SelectContent className="border-border bg-popover">
                          {contactFields.map((field) => (
                            <SelectItem key={field.value} value={field.value}>
                              {t(`personalize.fieldMap.${field.labelKey}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Select
                        value={mapping.value || undefined}
                        onValueChange={(val) =>
                          updateButtonVariable(slot.index, {
                            value: val || '',
                          })
                        }
                      >
                        <SelectTrigger className="w-full border-border bg-muted text-foreground">
                          <SelectValue
                            placeholder={
                              loadingFields
                                ? t('personalize.loadingFields')
                                : customFields.length === 0
                                  ? t('personalize.noCustomFields')
                                  : t('personalize.selectCustomField')
                            }
                          />
                        </SelectTrigger>
                        <SelectContent className="border-border bg-popover">
                          {customFields.map((f) => (
                            <SelectItem key={f.id} value={f.id}>
                              {f.field_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                </div>

                {slot.type === 'URL' && slot.url && (
                  <p className="mt-2 text-[11px] text-muted-foreground font-mono break-all">
                    {t('personalize.finalUrl', {
                      url: slot.url.replace(
                        /\{\{1\}\}/g,
                        sampleVal || slot.example || '{{1}}',
                      ),
                    })}
                  </p>
                )}
                {slot.type === 'COPY_CODE' && (
                  <p className="mt-2 text-[11px] text-muted-foreground font-mono">
                    {t('personalize.couponCode', {
                      code: sampleVal || slot.example || '—',
                    })}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Live Preview — rendered as a WhatsApp-style bubble so the user
          sees approximately what the recipient will see. */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <div className="mb-3 flex items-center gap-2">
          <Eye className="h-4 w-4 text-primary" />
          <p className="text-sm font-medium text-foreground">
            {t('personalize.preview')}
          </p>
          <span className="text-xs text-muted-foreground">
            ({previewLabel})
          </span>
          {loadingPreview && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          )}
        </div>
        <div className="rounded-lg bg-[#0e1a12] p-3">
          <div className="ml-auto max-w-[85%] rounded-lg bg-primary/25 border border-primary/20 px-3 py-2 shadow-sm text-foreground overflow-hidden">
            {mediaHeaderType && headerMediaUrl.trim() && (
              <div className="mb-2 -mx-3 -mt-2">
                {mediaHeaderType === 'image' && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={headerMediaUrl.trim()}
                    alt="Header Preview"
                    className="max-h-48 w-full object-cover rounded-t-lg"
                  />
                )}
                {mediaHeaderType !== 'image' && (
                  <div className="bg-primary/20 p-2 text-xs flex items-center gap-2 font-mono">
                    <ImageIcon className="h-4 w-4 text-primary" />
                    <span>[{mediaHeaderType.toUpperCase()} HEADER]</span>
                  </div>
                )}
              </div>
            )}
            <p className="whitespace-pre-wrap text-sm text-foreground leading-relaxed">
              {previewText}
            </p>
            {template.footer_text && (
              <p className="mt-1 text-xs text-muted-foreground">
                {template.footer_text}
              </p>
            )}
            {template.buttons && template.buttons.length > 0 && (
              <div className="mt-3 divide-y divide-primary/20 border-t border-primary/20 -mx-3 -mb-2">
                {template.buttons.map((btn, i) => {
                  let subText = '';
                  let icon = null;
                  if (btn.type === 'URL') {
                    icon = <ExternalLink className="h-3.5 w-3.5 opacity-80" />;
                    const hasVar = extractVariableIndices(btn.url).length > 0;
                    if (hasVar) {
                      const val =
                        resolveButtonPreviewValue(i) ||
                        btn.example ||
                        '{{1}}';
                      subText = btn.url.replace(/\{\{1\}\}/g, val);
                    }
                  } else if (btn.type === 'COPY_CODE') {
                    icon = <Copy className="h-3.5 w-3.5 opacity-80" />;
                    const val = resolveButtonPreviewValue(i) || btn.example;
                    if (val) subText = `Code: ${val}`;
                  } else if (btn.type === 'PHONE_NUMBER') {
                    icon = <Phone className="h-3.5 w-3.5 opacity-80" />;
                    subText = btn.phone_number;
                  } else {
                    icon = (
                      <CornerDownLeft className="h-3.5 w-3.5 opacity-80" />
                    );
                  }

                  return (
                    <div
                      key={i}
                      className="flex flex-col items-center justify-center py-2 text-center text-xs font-medium text-primary hover:bg-primary/10 transition-colors"
                    >
                      <div className="flex items-center gap-1.5">
                        {icon}
                        <span>{btn.text}</span>
                      </div>
                      {subText && (
                        <span className="text-[10px] text-muted-foreground font-mono mt-0.5 max-w-[90%] truncate">
                          {subText}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {allUnmapped.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          {t.rich('personalize.unmappedWarning', {
            keys: allUnmapped.join(', '),
            mono: (chunks) => (
              <span className="font-mono font-semibold">{chunks}</span>
            ),
          })}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={allUnmapped.length > 0 || headerMediaError !== null}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
