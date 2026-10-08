import { describe, expect, it } from 'vitest';
import { resolveVariables, resolveButtonVariables } from './use-broadcast-sending';
import type { Contact, TemplateButton } from '@/types';

const SAMPLE_CONTACT: Contact = {
  id: 'c1',
  user_id: 'u1',
  account_id: 'a1',
  name: 'Jane Doe',
  phone: '+14155552671',
  email: 'jane@example.com',
  company: 'Acme Inc',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

describe('resolveButtonVariables', () => {
  it('returns empty object when template has no buttons', () => {
    const res = resolveButtonVariables({}, SAMPLE_CONTACT, undefined, []);
    expect(res).toEqual({});
  });

  it('resolves static button variable mapping', () => {
    const buttons: TemplateButton[] = [
      { type: 'URL', text: 'Visit', url: 'https://example.com/order/{{1}}' },
    ];
    const res = resolveButtonVariables(
      { 0: { type: 'static', value: 'ORD-999' } },
      SAMPLE_CONTACT,
      undefined,
      buttons,
    );
    expect(res).toEqual({ 0: 'ORD-999' });
  });

  it('resolves contact field button variable mapping', () => {
    const buttons: TemplateButton[] = [
      { type: 'URL', text: 'Track', url: 'https://track.com/{{1}}' },
    ];
    const res = resolveButtonVariables(
      { 0: { type: 'field', value: 'phone' } },
      SAMPLE_CONTACT,
      undefined,
      buttons,
    );
    expect(res).toEqual({ 0: '+14155552671' });
  });

  it('resolves custom field button variable mapping', () => {
    const buttons: TemplateButton[] = [
      { type: 'URL', text: 'Tracking', url: 'https://example.com/track/{{1}}' },
    ];
    const customValues = new Map([['cf-tracking', 'TRACK-12345']]);
    const res = resolveButtonVariables(
      { 0: { type: 'custom_field', value: 'cf-tracking' } },
      SAMPLE_CONTACT,
      customValues,
      buttons,
    );
    expect(res).toEqual({ 0: 'TRACK-12345' });
  });

  it('falls back to COPY_CODE button example when no override is set', () => {
    const buttons: TemplateButton[] = [
      { type: 'COPY_CODE', text: 'Copy Promo', example: 'FALLBACK50' },
    ];
    const res = resolveButtonVariables(
      {},
      SAMPLE_CONTACT,
      undefined,
      buttons,
    );
    expect(res).toEqual({ 0: 'FALLBACK50' });
  });

  it('overrides COPY_CODE button example with specified value', () => {
    const buttons: TemplateButton[] = [
      { type: 'COPY_CODE', text: 'Copy Promo', example: 'FALLBACK50' },
    ];
    const res = resolveButtonVariables(
      { 0: { type: 'static', value: 'VIP100' } },
      SAMPLE_CONTACT,
      undefined,
      buttons,
    );
    expect(res).toEqual({ 0: 'VIP100' });
  });
});
