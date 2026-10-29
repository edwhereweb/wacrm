"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { CURRENCIES } from "@/lib/currency";
import { contactSearchFilter } from "@/lib/contacts/search-filter";
import {
  CONTACT_PICKER_LIMIT,
  withSelectedContact,
} from "@/lib/contacts/contact-picker";
import type {
  Contact,
  Conversation,
  Deal,
  DealStatus,
  PipelineStage,
  Profile,
} from "@/types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Check,
  X,
  Trash2,
  MessageSquare,
  DollarSign,
  Loader2,
  Phone,
  Mail,
  Tag as TagIcon,
  Copy,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import type { Tag } from "@/types";
import { LmsEnrollmentsSection } from "@/components/inbox/lms-enrollments-section";
import { contactHandle } from "@/lib/whatsapp/wa-identity";

interface DealFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deal?: Deal | null;
  pipelineId: string;
  stages: PipelineStage[];
  defaultStageId?: string;
  onSaved: () => void;
}

export function DealForm({
  open,
  onOpenChange,
  deal,
  pipelineId,
  stages,
  defaultStageId,
  onSaved,
}: DealFormProps) {
  const t = useTranslations("Pipelines.form");
  const supabase = createClient();
  const { accountId, defaultCurrency } = useAuth();

  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [contactId, setContactId] = useState("");
  const [stageId, setStageId] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [expectedCloseDate, setExpectedCloseDate] = useState("");
  const [notes, setNotes] = useState("");

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactSearch, setContactSearch] = useState("");
  const [pickedContact, setPickedContact] = useState<Contact | null>(null);
  const contactSearchSeq = useRef(0);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [linkedConversation, setLinkedConversation] =
    useState<Conversation | null>(null);

  const [saving, setSaving] = useState(false);
  const [statusAction, setStatusAction] = useState<DealStatus | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [contactTags, setContactTags] = useState<(Tag & { contact_tag_id: string })[]>([]);
  const router = useRouter();
  const [openingConversation, setOpeningConversation] = useState(false);
  const [copiedPhone, setCopiedPhone] = useState(false);

  const selectedContact = contacts.find((c) => c.id === contactId) || null;

  const handleCopyPhone = async (phoneToCopy: string) => {
    if (!phoneToCopy) return;
    await navigator.clipboard.writeText(phoneToCopy);
    setCopiedPhone(true);
    setTimeout(() => setCopiedPhone(false), 2000);
  };

  const handleOpenConversation = async () => {
    if (!selectedContact) return;
    setOpeningConversation(true);

    try {
      let convId = linkedConversation?.id;

      // If we don't have a linked conversation yet, check DB or find/create one
      if (!convId && contactId && accountId) {
        const { data: existing } = await supabase
          .from("conversations")
          .select("id")
          .eq("account_id", accountId)
          .eq("contact_id", contactId)
          .order("last_message_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (existing?.id) {
          convId = existing.id;
        } else {
          // If no conversation exists yet, create one for this contact
          const {
            data: { session },
          } = await supabase.auth.getSession();
          if (session?.user) {
            const { data: created } = await supabase
              .from("conversations")
              .insert({
                account_id: accountId,
                user_id: session.user.id,
                contact_id: contactId,
                status: "open",
              })
              .select("id")
              .maybeSingle();
            if (created?.id) {
              convId = created.id;
            }
          }
        }
      }

      const phone = selectedContact.phone || "";
      const params = new URLSearchParams();
      if (convId) params.set("c", convId);
      if (phone) {
        params.set("search", phone);
        params.set("phone", phone);
      } else if (selectedContact.name) {
        params.set("search", selectedContact.name);
      }
      if (contactId) params.set("contactId", contactId);

      onOpenChange(false);
      router.push(`/inbox?${params.toString()}`);
    } catch (err) {
      console.error("Failed to link to conversation:", err);
      const phone = selectedContact.phone || selectedContact.name || "";
      onOpenChange(false);
      router.push(`/inbox?search=${encodeURIComponent(phone)}&phone=${encodeURIComponent(phone)}`);
    } finally {
      setOpeningConversation(false);
    }
  };

  // Reset the form fields every time the sheet opens or its input
  // props change. This is a legitimate prop-driven sync; the rule is
  // over-cautious here, hence the block-level disable.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    setConfirmDelete(false);
    setContactSearch("");
    setPickedContact(deal?.contact ?? null);
    if (deal) {
      setTitle(deal.title);
      setValue(String(deal.value ?? ""));
      setCurrency(deal.currency || defaultCurrency);
      // contact_id is nullable when the contact has been deleted
      // (migration 004: ON DELETE SET NULL). "" means "no selection".
      setContactId(deal.contact_id ?? "");
      setStageId(deal.stage_id);
      setAssignedTo(deal.assigned_to ?? "");
      setExpectedCloseDate(deal.expected_close_date ?? "");
      setNotes(deal.notes ?? "");
    } else {
      setTitle("");
      setValue("");
      setCurrency(defaultCurrency);
      setContactId("");
      setStageId(defaultStageId || stages[0]?.id || "");
      setAssignedTo("");
      setExpectedCloseDate("");
      setNotes("");
    }
  }, [open, deal, defaultStageId, stages, defaultCurrency]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Load supporting data once the sheet is open
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const p = await supabase.from("profiles").select("*").order("full_name");
      if (cancelled) return;
      setProfiles((p.data ?? []) as Profile[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, supabase]);

  useEffect(() => {
    if (!open || !accountId) return;
    const seq = ++contactSearchSeq.current;
    const timer = setTimeout(async () => {
      let query = supabase
        .from("contacts")
        .select("*")
        .eq("account_id", accountId)
        .order("name")
        .limit(CONTACT_PICKER_LIMIT);
      const filter = contactSearchFilter(contactSearch);
      if (filter) query = query.or(filter);
      const { data, error } = await query;
      if (seq !== contactSearchSeq.current || error) return;
      setContacts((data ?? []) as Contact[]);
    }, contactSearch ? 250 : 0);
    return () => clearTimeout(timer);
  }, [open, accountId, contactSearch, supabase]);

  const contactOptions = withSelectedContact(
    contacts,
    contacts.find((c) => c.id === contactId) ??
      (pickedContact?.id === contactId ? pickedContact : null),
  );

  // Fetch linked conversation for the selected contact (newest open one).
  // Clearing on no-selection is sync with prop state; the populated
  // case runs setLinkedConversation inside the async fetch callback.
  useEffect(() => {
    if (!open || !contactId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLinkedConversation(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("conversations")
        .select("*")
        .eq("contact_id", contactId)
        .order("last_message_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      setLinkedConversation((data as Conversation | null) ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, contactId, supabase]);

  // Fetch tags for selected contact
  useEffect(() => {
    if (!open || !contactId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setContactTags([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("contact_tags")
        .select("id, tag_id, tags(*)")
        .eq("contact_id", contactId);
      if (cancelled) return;
      if (data) {
        const mapped = data
          .filter((ct: Record<string, unknown>) => ct.tags)
          .map((ct: Record<string, unknown>) => ({
            ...(ct.tags as Tag),
            contact_tag_id: ct.id as string,
          }));
        setContactTags(mapped);
      } else {
        setContactTags([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, contactId, supabase]);

  async function handleSave() {
    if (!title.trim() || !contactId || !stageId) {
      toast.error(t("toastRequired"));
      return;
    }
    setSaving(true);

    const payload = {
      title: title.trim(),
      value: parseFloat(value) || 0,
      currency,
      contact_id: contactId,
      pipeline_id: pipelineId,
      stage_id: stageId,
      assigned_to: assignedTo || null,
      notes: notes.trim() || null,
      expected_close_date: expectedCloseDate || null,
    };

    if (deal) {
      const { error } = await supabase
        .from("deals")
        .update(payload)
        .eq("id", deal.id);
      if (error) {
        toast.error(t("toastFailedSave"));
        setSaving(false);
        return;
      }
    } else {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        toast.error(t("toastNotSignedIn"));
        setSaving(false);
        return;
      }
      if (!accountId) {
        toast.error(t("toastNotLinked"));
        setSaving(false);
        return;
      }
      const { error } = await supabase
        .from("deals")
        .insert({ ...payload, user_id: user.id, account_id: accountId, status: "open" });
      if (error) {
        toast.error(t("toastFailedCreate"));
        setSaving(false);
        return;
      }
    }

    setSaving(false);
    toast.success(deal ? t("toastUpdated") : t("toastCreated"));
    onOpenChange(false);
    onSaved();
  }

  async function handleStatusChange(status: DealStatus) {
    if (!deal) return;
    setStatusAction(status);
    const { error } = await supabase
      .from("deals")
      .update({ status })
      .eq("id", deal.id);
    setStatusAction(null);
    if (error) {
      toast.error(t("toastFailedStatus"));
      return;
    }
    toast.success(
      status === "won" ? t("toastMarkedWon") : status === "lost" ? t("toastMarkedLost") : t("toastReopened"),
    );
    onOpenChange(false);
    onSaved();
  }

  async function handleDelete() {
    if (!deal) return;
    setDeleting(true);
    const { error } = await supabase.from("deals").delete().eq("id", deal.id);
    setDeleting(false);
    if (error) {
      toast.error(t("toastFailedDelete"));
      return;
    }
    toast.success(t("toastDeleted"));
    setConfirmDelete(false);
    onOpenChange(false);
    onSaved();
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="bg-popover border-border text-popover-foreground sm:max-w-lg w-full p-0"
      >
        <div className="flex h-full flex-col">
          <SheetHeader className="border-b border-border/50 p-4">
            <SheetTitle className="text-popover-foreground">
              {deal ? t("editDeal") : t("newDeal")}
            </SheetTitle>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("title")}</Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("titlePlaceholder")}
                className="border-border bg-muted text-foreground"
              />
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("contact")}</Label>
              <Input
                value={contactSearch}
                onChange={(e) => setContactSearch(e.target.value)}
                placeholder={t("searchContacts")}
                className="border-border bg-muted text-foreground"
              />
              <select
                value={contactId}
                onChange={(e) => {
                  setContactId(e.target.value);
                  setPickedContact(
                    contactOptions.find((c) => c.id === e.target.value) ?? null,
                  );
                }}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                <option value="">{t("selectContact")}</option>
                {contactOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name || c.phone}
                  </option>
                ))}
              </select>

              {selectedContact && (
                <div className="mt-2 rounded-lg border border-border/60 bg-muted/40 p-3 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-foreground">
                      {selectedContact.name || contactHandle(selectedContact)}
                    </span>
                    <button
                      type="button"
                      onClick={handleOpenConversation}
                      disabled={openingConversation}
                      className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/20 transition-colors disabled:opacity-50 cursor-pointer"
                      title={t("linkToConversation")}
                    >
                      {openingConversation ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <MessageSquare className="h-3 w-3" />
                      )}
                      {t("linkToConversation")}
                    </button>
                  </div>

                  {/* Phone & Email */}
                  <div className="space-y-1.5 text-xs text-muted-foreground">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Phone className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{contactHandle(selectedContact)}</span>
                      </div>
                      {contactHandle(selectedContact) && (
                        <button
                          type="button"
                          onClick={() => handleCopyPhone(contactHandle(selectedContact))}
                          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                          title="Copy number"
                        >
                          {copiedPhone ? (
                            <Check className="h-3 w-3 text-primary" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </button>
                      )}
                    </div>
                    {selectedContact.email && (
                      <div className="flex items-center gap-1.5">
                        <Mail className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{selectedContact.email}</span>
                      </div>
                    )}
                  </div>

                  {/* Tags */}
                  {contactTags.length > 0 && (
                    <div className="space-y-1 border-t border-border/40 pt-2">
                      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        <TagIcon className="h-3 w-3" />
                        <span>Tags</span>
                      </div>
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {contactTags.map((tag) => (
                          <span
                            key={tag.contact_tag_id}
                            className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                            style={{
                              backgroundColor: `${tag.color}20`,
                              color: tag.color,
                            }}
                          >
                            {tag.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* LMS Enrollments (Courses & Webinars) */}
                  {(selectedContact.phone?.trim() || selectedContact.email?.trim()) && (
                    <div className="border-t border-border/40 pt-2">
                      <LmsEnrollmentsSection
                        phone={selectedContact.phone}
                        email={selectedContact.email}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="grid grid-cols-[1fr_110px] gap-3">
              <div className="grid gap-2">
                <Label className="text-muted-foreground">{t("value")}</Label>
                <div className="relative">
                  <DollarSign className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    type="number"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder="0"
                    className="border-border bg-muted pl-7 text-foreground"
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">{t("currency")}</Label>
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
                >
                  {CURRENCIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("expectedCloseDate")}</Label>
              <Input
                type="date"
                value={expectedCloseDate}
                onChange={(e) => setExpectedCloseDate(e.target.value)}
                className="border-border bg-muted text-foreground"
              />
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("stage")}</Label>
              <select
                value={stageId}
                onChange={(e) => setStageId(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
              >
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("assignedTo")}</Label>
              <select
                value={assignedTo}
                onChange={(e) => setAssignedTo(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
              >
                <option value="">{t("unassigned")}</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.full_name || p.email}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("notes")}</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t("notesPlaceholder")}
                className="min-h-[100px] border-border bg-muted text-foreground"
              />
            </div>

            {deal && (
              <div className="space-y-2 rounded-lg border border-border bg-muted/50 p-3">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {t("status")}
                </p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    onClick={() => handleStatusChange("won")}
                    disabled={!!statusAction || deal.status === "won"}
                    className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {statusAction === "won" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <Check className="mr-1 h-4 w-4" />
                        {t("markAsWon")}
                      </>
                    )}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => handleStatusChange("lost")}
                    disabled={!!statusAction || deal.status === "lost"}
                    className="flex-1 bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {statusAction === "lost" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <X className="mr-1 h-4 w-4" />
                        {t("markAsLost")}
                      </>
                    )}
                  </Button>
                </div>
                {deal.status && deal.status !== "open" && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => handleStatusChange("open")}
                    disabled={!!statusAction}
                    className="w-full text-muted-foreground hover:text-foreground"
                  >
                    {t("reopenDeal")}
                  </Button>
                )}
              </div>
            )}
          </div>

          <div className="border-t border-border/50 bg-popover/80 p-4">
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="flex-1 border-border bg-transparent text-muted-foreground hover:bg-muted"
              >
                {t("cancel")}
              </Button>
              <Button
                onClick={handleSave}
                disabled={saving || !title.trim() || !contactId || !stageId}
                className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {saving ? t("saving") : deal ? t("saveChanges") : t("createDeal")}
              </Button>
            </div>

            {deal &&
              (confirmDelete ? (
                <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs">
                  <span className="text-red-300">{t("deletePrompt")}</span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      disabled={deleting}
                      className="rounded px-2 py-1 text-muted-foreground hover:bg-muted"
                    >
                      {t("cancel")}
                    </button>
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={deleting}
                      className="rounded bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {deleting ? t("deleting") : t("confirm")}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="mt-3 flex w-full items-center justify-center gap-1 text-xs text-red-400 hover:text-red-300"
                >
                  <Trash2 className="h-3 w-3" />
                  {t("deleteDeal")}
                </button>
              ))}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
