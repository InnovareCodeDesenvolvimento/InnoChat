"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, Clock, Eye, Filter, MailX, RotateCcw, Send, X } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Alert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Pagination } from "@/components/ui/pagination";
import { DEFAULT_PAGE_SIZE } from "@/components/lib/pagination";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/components/lib/cn";
import { formatTimeLabel } from "@/components/lib/format-date";
import { ChannelIcon, NoticeStatusBadge } from "@/components/admin/billing-ui";
import { getBillingNoticePreviewAction, resendBillingNoticeAction } from "@/modules/billing/finance-actions";
import { STEP_LABELS } from "@/core/billing/dunning-labels";
import type { DunningStep } from "@/core/billing/dunning-policy";
import {
  type BillingNoticeFilters,
  type BillingNoticeItem,
  type BillingNoticePage,
  type BillingNoticePreview,
  type NoticeChannel,
  type NoticeStatus,
} from "@/components/admin/billing-types";
import { formatCentsBRL, formatDateBR } from "@/modules/billing/format";

const TZ = "America/Sao_Paulo";

type FormState = {
  from: string;
  to: string;
  tenantQuery: string;
  channel: "" | NoticeChannel;
  status: "" | NoticeStatus;
  step: string;
  onlyFailures: boolean;
};

function toForm(f: BillingNoticeFilters): FormState {
  return {
    from: f.from ?? "",
    to: f.to ?? "",
    tenantQuery: f.tenantQuery ?? "",
    channel: f.channel ?? "",
    status: f.status ?? "",
    step: f.step ?? "",
    onlyFailures: !!f.onlyFailures,
  };
}

function toFilters(f: FormState): BillingNoticeFilters {
  return {
    from: f.from || undefined,
    to: f.to || undefined,
    tenantQuery: f.tenantQuery.trim() || undefined,
    channel: f.channel || undefined,
    status: f.onlyFailures ? undefined : f.status || undefined,
    step: (f.step || undefined) as DunningStep | undefined,
    onlyFailures: f.onlyFailures || undefined,
  };
}

const EMPTY_FORM: FormState = { from: "", to: "", tenantQuery: "", channel: "", status: "", step: "", onlyFailures: false };

/** Destino completo, como o backend entrega (telefone já formatado); sem destino definido, diz isso. */
function displayRecipient(item: Pick<BillingNoticeItem, "recipient" | "recipientDisplay">): string {
  return item.recipientDisplay ?? item.recipient ?? "Ainda sem destino definido";
}

function attemptsLabel(n: number): string {
  if (n <= 0) return "Sem tentativas ainda";
  return `${n} ${n === 1 ? "tentativa" : "tentativas"}`;
}

function When({ at }: { at: string }) {
  const d = new Date(at);
  return (
    <>
      <span className="block font-medium tabular-nums text-text">{formatDateBR(d, TZ)}</span>
      <span className="block text-xs tabular-nums text-text-secondary">{formatTimeLabel(d, TZ)}</span>
    </>
  );
}

function CompanyCell({ item }: { item: BillingNoticeItem }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Avatar id={item.tenant.id} name={item.tenant.name} size="sm" />
      <div className="min-w-0">
        <Link
          href={`/admin/empresas/${item.tenant.id}`}
          className="relative block break-words font-medium text-text before:absolute before:inset-x-0 before:-inset-y-3 before:content-[''] hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {item.tenant.name}
        </Link>
        <p className="break-all text-xs text-text-secondary">/{item.tenant.slug}</p>
      </div>
    </div>
  );
}

function RecipientBlock({ item }: { item: BillingNoticeItem }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <ChannelIcon channel={item.channel} className="mt-0.5" />
      <div className="min-w-0">
        <p className="font-medium text-text [overflow-wrap:anywhere]" data-testid="notice-recipient">
          {displayRecipient(item)}
        </p>
        {item.recipientIsMasked && item.recipientNote ? <p className="text-xs text-text-secondary">{item.recipientNote}</p> : null}
        {item.senderPhoneDisplay ? <p className="text-xs text-text-secondary">Enviado pelo número {item.senderPhoneDisplay}</p> : null}
      </div>
    </div>
  );
}

function StatusBlock({ item }: { item: BillingNoticeItem }) {
  return (
    <div>
      <NoticeStatusBadge status={item.status} label={item.statusLabel} />
      {item.status === "SKIPPED" && (item.skippedReasonLabel || item.skippedReason) ? (
        <p className="mt-1 text-xs text-text-secondary">{item.skippedReasonLabel ?? item.skippedReason}</p>
      ) : null}
      {item.status === "FAILED" && (item.lastErrorLabel || item.lastErrorCode) ? (
        <p className="mt-1 text-xs text-text-secondary">{item.lastErrorLabel ?? `Código do erro: ${item.lastErrorCode}`}</p>
      ) : null}
      <p className="mt-1 text-xs text-text-secondary">{attemptsLabel(item.attempts)}</p>
    </div>
  );
}

function StepBlock({ item }: { item: BillingNoticeItem }) {
  return (
    <div>
      <p className="font-medium text-text">{item.stepLabel}</p>
      {item.invoice ? (
        <p className="text-xs text-text-secondary">
          Fatura de {formatCentsBRL(item.invoice.amountCents)}, vence em {formatDateBR(new Date(item.invoice.dueAt), TZ)}
        </p>
      ) : (
        <p className="text-xs text-text-secondary">Sem fatura ligada</p>
      )}
    </div>
  );
}

function TotalCard({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number; tone: "success" | "danger" | "neutral" | "warning" }) {
  const toneClass = {
    success: "bg-success-bg text-success",
    danger: "bg-danger-bg text-danger",
    warning: "bg-warning-bg text-warning",
    neutral: "bg-bg text-text-secondary",
  }[tone];
  return (
    <Card className="flex items-center gap-3 rounded-hero p-4">
      <span className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-full [&>svg]:h-5 [&>svg]:w-5", toneClass)}>{icon}</span>
      <div className="min-w-0">
        <p className="text-sm text-text-secondary">{label}</p>
        <p className="font-display text-2xl font-black tabular-nums text-text">{value.toLocaleString("pt-BR")}</p>
      </div>
    </Card>
  );
}

export type NoticePageData = BillingNoticePage & { page: number; pageSize: number; totalItems: number; totalPages: number };

/** Monta a URL da tela: filtros + página + tamanho. Só entra o que foi preenchido. */
function buildQuery(f: BillingNoticeFilters, page: number, pageSize: number): string {
  const q = new URLSearchParams();
  if (f.tenantQuery) q.set("tenantQuery", f.tenantQuery);
  if (f.channel) q.set("channel", f.channel);
  if (f.status) q.set("status", f.status);
  if (f.step) q.set("step", f.step);
  if (f.from) q.set("from", f.from);
  if (f.to) q.set("to", f.to);
  if (f.onlyFailures) q.set("falhas", "1");
  if (page > 1) q.set("pagina", String(page));
  if (pageSize !== DEFAULT_PAGE_SIZE) q.set("porPagina", String(pageSize));
  const text = q.toString();
  return text ? `?${text}` : "";
}

export function EnviosClient({
  data,
  filters: applied,
}: {
  data: NoticePageData;
  filters: BillingNoticeFilters;
}) {
  const { notify } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [form, setForm] = useState<FormState>(toForm(applied));
  const { items, totals, page, pageSize } = data;

  function go(filters: BillingNoticeFilters, nextPage: number, nextSize: number) {
    startTransition(() => router.push(`${pathname}${buildQuery(filters, nextPage, nextSize)}`));
  }

  const [previewTarget, setPreviewTarget] = useState<BillingNoticeItem | null>(null);
  const [preview, setPreview] = useState<BillingNoticePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewRequest = useRef(0);

  const [resendTarget, setResendTarget] = useState<BillingNoticeItem | null>(null);
  const [resending, setResending] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);

  function applyFilters(e?: React.FormEvent) {
    e?.preventDefault();
    go(toFilters(form), 1, pageSize);
  }

  function clearFilters() {
    setForm(EMPTY_FORM);
    go({}, 1, pageSize);
  }

  async function openPreview(item: BillingNoticeItem) {
    const id = ++previewRequest.current;
    setPreviewTarget(item);
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    const result = await getBillingNoticePreviewAction(item.id);
    if (id !== previewRequest.current) return;
    setPreviewLoading(false);
    if (!result.ok) {
      setPreviewError(result.error.message);
      return;
    }
    setPreview(result.data);
  }

  function closePreview() {
    previewRequest.current += 1;
    setPreviewTarget(null);
  }

  async function confirmResend() {
    if (!resendTarget) return;
    setResending(true);
    setResendError(null);
    const result = await resendBillingNoticeAction(resendTarget.id);
    setResending(false);
    if (!result.ok) {
      setResendError(result.error.message);
      return;
    }
    notify({
      variant: "success",
      title: result.data.alreadyQueued ? "Este aviso já tinha sido reenviado." : "Reenvio feito.",
      description: result.data.alreadyQueued ? "Mostramos o reenvio que já existe." : "O novo aviso aparece no topo da lista com o resultado.",
    });
    setResendTarget(null);
    router.refresh();
  }

  const hasFilter = Object.values(applied).some((v) => v !== undefined && v !== false);

  const actions = (item: BillingNoticeItem) => (
    <div className="flex flex-wrap justify-end gap-1.5">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        icon={Eye}
        onClick={() => void openPreview(item)}
        aria-label={`Ver mensagem: ${item.stepLabel} para ${item.tenant.name}`}
      >
        Ver mensagem
      </Button>
      {item.canResend ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          icon={RotateCcw}
          onClick={() => {
            setResendError(null);
            setResendTarget(item);
          }}
          aria-label={`Reenviar: ${item.stepLabel} para ${item.tenant.name}`}
        >
          Reenviar
        </Button>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        icon={navIconFor("admin/envios")}
        title="Envios de cobrança"
        description="Cada aviso mandado às empresas: para quem foi, por qual canal e se chegou."
        help="pagina.adminEnvios"
        className="mb-2"
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-live="polite" aria-busy={isPending || undefined}>
        <TotalCard icon={<CheckCircle2 aria-hidden="true" />} label="Enviados" value={totals.sent} tone="success" />
        <TotalCard icon={<AlertTriangle aria-hidden="true" />} label="Falharam" value={totals.failed} tone="danger" />
        <TotalCard icon={<MailX aria-hidden="true" />} label="Não enviados" value={totals.skipped} tone="neutral" />
        <TotalCard icon={<Clock aria-hidden="true" />} label="Na fila" value={totals.pending} tone="warning" />
      </div>

      <Card className="rounded-hero">
        <CardHeader help="admin.enviosFiltros" className="py-3.5">
          <CardTitle className="text-base">Filtros</CardTitle>
        </CardHeader>
        <CardContent className="p-4">
          <form onSubmit={applyFilters} className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Field label="Enviado de">
                {(p) => <Input {...p} type="date" className="w-full" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />}
              </Field>
              <Field label="Enviado até">
                {(p) => <Input {...p} type="date" className="w-full" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />}
              </Field>
              <Field label="Empresa">
                {(p) => (
                  <Input
                    {...p}
                    className="w-full"
                    placeholder="Nome da empresa"
                    maxLength={120}
                    value={form.tenantQuery}
                    onChange={(e) => setForm({ ...form, tenantQuery: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Canal">
                {(p) => (
                  <Select {...p} value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value as FormState["channel"] })}>
                    <option value="">Todos</option>
                    <option value="EMAIL">E-mail</option>
                    <option value="WHATSAPP">WhatsApp</option>
                  </Select>
                )}
              </Field>
              <Field label="Etapa do aviso">
                {(p) => (
                  <Select {...p} value={form.step} onChange={(e) => setForm({ ...form, step: e.target.value })}>
                    <option value="">Todas</option>
                    {Object.entries(STEP_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Situação">
                {(p) => (
                  <Select
                    {...p}
                    disabled={form.onlyFailures}
                    value={form.onlyFailures ? "FAILED" : form.status}
                    onChange={(e) => setForm({ ...form, status: e.target.value as FormState["status"] })}
                  >
                    <option value="">Todas</option>
                    <option value="SENT">Enviado</option>
                    <option value="FAILED">Falhou</option>
                    <option value="SKIPPED">Não enviado</option>
                    <option value="PENDING">Na fila</option>
                    <option value="SENDING">Enviando</option>
                  </Select>
                )}
              </Field>
              <div className="flex items-end">
                <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-medium text-text">
                  <input
                    type="checkbox"
                    className="h-5 w-5 shrink-0 accent-[var(--color-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    checked={form.onlyFailures}
                    onChange={(e) => setForm({ ...form, onlyFailures: e.target.checked })}
                  />
                  Só falhas
                </label>
              </div>
              <div className="flex items-end gap-2">
                <Button type="submit" icon={Filter} variant="secondary" isLoading={isPending} loadingText="Filtrando…" className="flex-1 xl:flex-none">
                  Filtrar
                </Button>
                <Button type="button" variant="ghost" icon={X} onClick={clearFilters} disabled={isPending}>
                  Limpar
                </Button>
              </div>
            </div>
          </form>
        </CardContent>
      </Card>

      {items.length === 0 ? (
        <EmptyState
          icon={Send}
          title={hasFilter ? "Nenhum envio com esses filtros" : "Nenhum aviso enviado ainda"}
          description={hasFilter ? "Ajuste ou limpe os filtros para ver outros envios." : "Quando a cobrança mandar o primeiro aviso, ele aparece aqui."}
        />
      ) : (
        <>
          <div className={isPending ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={isPending || undefined}>
          <Card className="hidden rounded-hero xl:block" data-testid="notices-table">
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeadCell>Quando</TableHeadCell>
                  <TableHeadCell>Empresa</TableHeadCell>
                  <TableHeadCell>Aviso</TableHeadCell>
                  <TableHeadCell>Para quem</TableHeadCell>
                  <TableHeadCell>Situação</TableHeadCell>
                  <TableHeadCell className="text-right">Ações</TableHeadCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id} className="align-top">
                    <TableCell className="whitespace-nowrap">
                      <When at={item.at} />
                    </TableCell>
                    <TableCell className="min-w-[11rem] max-w-[13rem]">
                      <CompanyCell item={item} />
                    </TableCell>
                    <TableCell className="min-w-[11rem] max-w-[13rem]">
                      <StepBlock item={item} />
                    </TableCell>
                    <TableCell className="min-w-[15rem]">
                      <RecipientBlock item={item} />
                    </TableCell>
                    <TableCell>
                      <StatusBlock item={item} />
                    </TableCell>
                    <TableCell>{actions(item)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          <ul className="flex flex-col gap-3 xl:hidden" data-testid="notices-cards">
            {items.map((item) => (
              <li key={item.id}>
                <Card className="rounded-hero p-4">
                  <div className="flex items-start justify-between gap-3">
                    <CompanyCell item={item} />
                    <div className="shrink-0 text-right text-sm">
                      <When at={item.at} />
                    </div>
                  </div>
                  <div className="mt-3 flex flex-col gap-3 border-t border-border pt-3">
                    <StepBlock item={item} />
                    <RecipientBlock item={item} />
                    <StatusBlock item={item} />
                    {actions(item)}
                  </div>
                </Card>
              </li>
            ))}
          </ul>

          </div>

          <Pagination
            label="Paginação dos envios"
            page={page}
            pageSize={pageSize}
            totalItems={data.totalItems}
            totalPages={data.totalPages}
            isPending={isPending}
            onPageChange={(p) => go(applied, p, pageSize)}
            onPageSizeChange={(size) => go(applied, 1, size)}
          />
        </>
      )}

      <Dialog open={!!previewTarget} onOpenChange={(open) => !open && closePreview()}>
        <DialogContent className="w-[min(36rem,calc(100vw-2rem))]">
          <DialogHeader icon={Eye}>
            <DialogTitle>Mensagem enviada</DialogTitle>
            <DialogDescription>
              {previewTarget ? `${previewTarget.stepLabel} para ${previewTarget.tenant.name}, ${displayRecipient(previewTarget)}.` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex flex-col gap-3" aria-busy={previewLoading || undefined}>
            {previewLoading ? (
              <div aria-hidden="true" className="flex flex-col gap-2">
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-32" />
              </div>
            ) : previewError ? (
              <Alert variant="danger">{previewError}</Alert>
            ) : preview ? (
              <>
                {preview.approximate ? (
                  <Alert variant="info">
                    {preview.approximateReason ?? "Este texto foi refeito com os dados de hoje. O que a empresa recebeu pode ter pequenas diferenças."}
                  </Alert>
                ) : null}
                {preview.subject ? (
                  <p className="text-sm text-text">
                    <span className="text-text-secondary">Assunto: </span>
                    <span className="font-medium">{preview.subject}</span>
                  </p>
                ) : null}
                <div className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto rounded-card border border-border bg-bg p-4" data-testid="notice-preview-text">
                  {(preview.messages.length > 0 ? preview.messages : [preview.text]).map((message, i) => (
                    <p
                      key={i}
                      className={cn(
                        "whitespace-pre-wrap break-words text-sm leading-relaxed text-text",
                        preview.channel === "WHATSAPP" && "rounded-card border border-success/20 bg-success-bg px-3 py-2",
                      )}
                    >
                      {message}
                    </p>
                  ))}
                </div>
              </>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" icon={X} onClick={closePreview}>
              Fechar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!resendTarget} onOpenChange={(open) => !open && !resending && setResendTarget(null)}>
        <DialogContent>
          <DialogHeader icon={RotateCcw} tone="warning">
            <DialogTitle>Reenviar este aviso?</DialogTitle>
            <DialogDescription>
              {resendTarget
                ? `${resendTarget.stepLabel} vai ser mandado de novo para ${displayRecipient(resendTarget)} (${resendTarget.tenant.name}).`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {resendError ? (
            <div className="mt-4">
              <Alert variant="danger">{resendError}</Alert>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" icon={X} onClick={() => setResendTarget(null)} disabled={resending}>
              Cancelar
            </Button>
            <Button type="button" icon={RotateCcw} onClick={() => void confirmResend()} isLoading={resending} loadingText="Reenviando…">
              Reenviar aviso
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
