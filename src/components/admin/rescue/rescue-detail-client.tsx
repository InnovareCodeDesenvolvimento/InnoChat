"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Building2,
  CheckCircle2,
  Clock,
  History,
  Info,
  MessageSquare,
  Pause,
  Play,
  RefreshCw,
  Send,
  User,
  UserCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader } from "@/components/ui/page-header";
import { formatPhoneDisplay } from "@/components/lib/format-phone";
import { useToast } from "@/components/ui/toast";
import { RESCUE_STATUS_CONFIG } from "@/modules/rescue/labels";
import {
  markRescueLeadConvertedAction,
  pauseRescueLeadAction,
  resendRescueMessageAction,
  resumeRescueLeadAction,
  type RescueLeadDetail,
} from "@/modules/rescue/admin-actions";

export type RescueDetailClientProps = {
  lead: RescueLeadDetail;
};

type ActionType = "pause" | "resume" | "convert" | "resend" | null;

export function RescueDetailClient({ lead: initialLead }: RescueDetailClientProps) {
  const router = useRouter();
  const { notify } = useToast();
  const [lead, setLead] = useState<RescueLeadDetail>(initialLead);

  const [activeAction, setActiveAction] = useState<ActionType>(null);
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const statusConfig = RESCUE_STATUS_CONFIG[lead.status] ?? {
    label: lead.status,
    variant: "neutral",
    description: "",
  };

  function openAction(action: ActionType) {
    setActiveAction(action);
    setReason("");
    setActionError(null);
  }

  function closeAction() {
    setActiveAction(null);
    setReason("");
    setActionError(null);
  }

  async function handleConfirmAction() {
    if (reason.trim().length < 15) {
      setActionError("O motivo precisa ter pelo menos 15 caracteres.");
      return;
    }
    if (reason.trim().length > 500) {
      setActionError("O motivo pode ter no máximo 500 caracteres.");
      return;
    }

    setIsSubmitting(true);
    setActionError(null);

    try {
      if (activeAction === "pause") {
        const res = await pauseRescueLeadAction(lead.id, reason.trim());
        if (!res.ok) {
          setActionError(res.error.message);
          notify({ variant: "error", title: "Não foi possível pausar o lead", description: res.error.message });
          return;
        }
        setLead((prev) => ({ ...prev, status: res.data.status, nextRunAt: null }));
        notify({ variant: "success", title: "Lead pausado com sucesso." });
      } else if (activeAction === "resume") {
        const res = await resumeRescueLeadAction(lead.id, reason.trim());
        if (!res.ok) {
          setActionError(res.error.message);
          notify({ variant: "error", title: "Não foi possível retomar o lead", description: res.error.message });
          return;
        }
        setLead((prev) => ({ ...prev, status: res.data.status, nextRunAt: new Date() }));
        notify({ variant: "success", title: "Lead retomado com sucesso." });
      } else if (activeAction === "convert") {
        const res = await markRescueLeadConvertedAction(lead.id, reason.trim());
        if (!res.ok) {
          setActionError(res.error.message);
          notify({ variant: "error", title: "Não foi possível marcar como convertido", description: res.error.message });
          return;
        }
        setLead((prev) => ({ ...prev, status: res.data.status, convertedAt: new Date(), nextRunAt: null }));
        notify({ variant: "success", title: "Lead marcado como convertido." });
      } else if (activeAction === "resend") {
        const res = await resendRescueMessageAction(lead.id, reason.trim());
        if (!res.ok) {
          setActionError(res.error.message);
          notify({ variant: "error", title: "Não foi possível reagendar o reenvio", description: res.error.message });
          return;
        }
        setLead((prev) => ({ ...prev, status: res.data.status, nextRunAt: res.data.nextRunAt, attempts: 0, lastErrorCode: null }));
        notify({ variant: "success", title: "Reenvio agendado imediatamente." });
      }

      closeAction();
      router.refresh();
    } catch {
      const fallbackMsg = "Falha ao processar a ação. Tente novamente em alguns instantes.";
      setActionError(fallbackMsg);
      notify({ variant: "error", title: "Erro de comunicação", description: fallbackMsg });
    } finally {
      setIsSubmitting(false);
    }
  }

  const formatDate = (date: Date | string | null | undefined) => {
    if (!date) return "—";
    return new Intl.DateTimeFormat("pt-BR", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: "America/Sao_Paulo",
    }).format(new Date(date));
  };

  const isTerminal = lead.status === "CONVERTED" || lead.status === "OPTED_OUT";
  const isPaused = lead.status === "SKIPPED";
  const isExpired = lead.status === "EXPIRED";

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Link href="/admin/resgate">
          <Button variant="ghost" size="sm" icon={ArrowLeft}>
            Voltar para a lista
          </Button>
        </Link>
      </div>

      <PageHeader
        icon={UserCheck}
        title={
          <div className="flex flex-wrap items-center gap-3">
            <span>{lead.userName || "Lead sem nome"}</span>
            <Badge variant={statusConfig.variant}>{statusConfig.label}</Badge>
          </div>
        }
        description={`Responsável cadastrado na empresa ${lead.tenantName}`}
        help="admin.resgateDetalhe"
        action={
          <div className="flex flex-wrap items-center gap-2">
            {!isTerminal && !isPaused && (
              <Button
                variant="outline"
                size="sm"
                icon={Pause}
                onClick={() => openAction("pause")}
              >
                Pausar resgate
              </Button>
            )}
            {(isPaused || isExpired) && (
              <Button
                variant="outline"
                size="sm"
                icon={Play}
                onClick={() => openAction("resume")}
              >
                Retomar resgate
              </Button>
            )}
            {!isTerminal && (
              <Button
                variant="outline"
                size="sm"
                icon={CheckCircle2}
                onClick={() => openAction("convert")}
              >
                Marcar como convertido
              </Button>
            )}
            {!isTerminal && (
              <Button
                variant="outline"
                size="sm"
                icon={RefreshCw}
                onClick={() => openAction("resend")}
              >
                Reenviar mensagem
              </Button>
            )}
          </div>
        }
      />

      {/* Grid de Dados Básicos */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Card className="border-border bg-surface p-5">
          <div className="mb-4 flex items-center gap-2 font-semibold text-text">
            <User className="h-4 w-4 text-primary" />
            <span>Dados de contato do responsável</span>
          </div>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm">
            <div>
              <dt className="text-xs text-text-muted">Nome informado</dt>
              <dd className="font-medium text-text">{lead.userName || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">Telefone / WhatsApp</dt>
              <dd className="font-medium text-text">{formatPhoneDisplay(lead.phoneE164)}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">E-mail de login</dt>
              <dd className="font-medium text-text">{lead.userEmail}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">E-mail verificado</dt>
              <dd className="font-medium text-text">
                {lead.userEmailVerifiedAt ? (
                  <span className="text-success">Sim ({formatDate(lead.userEmailVerifiedAt)})</span>
                ) : (
                  <span className="text-text-muted">Pendente de confirmação</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">Data do cadastro</dt>
              <dd className="font-medium text-text">{formatDate(lead.userCreatedAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">Último acesso ao painel (lastSeenAt)</dt>
              <dd className="font-medium text-text">
                {lead.userLastSeenAt ? (
                  <span className="text-success font-semibold">{formatDate(lead.userLastSeenAt)}</span>
                ) : (
                  <span className="text-warning">Nunca acessou o painel</span>
                )}
              </dd>
            </div>
          </dl>
        </Card>

        <Card className="border-border bg-surface p-5">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2 font-semibold text-text">
              <Building2 className="h-4 w-4 text-primary" />
              <span>Empresa vinculada</span>
            </div>
            <Link href={`/admin/empresas/${lead.tenantId}`}>
              <Button variant="ghost" size="sm">
                Ver empresa
              </Button>
            </Link>
          </div>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm">
            <div>
              <dt className="text-xs text-text-muted">Nome da empresa</dt>
              <dd className="font-medium text-text">{lead.tenantName}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">Endereço (slug)</dt>
              <dd className="font-medium text-text">/{lead.tenantSlug}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">CPF ou CNPJ</dt>
              <dd className="font-medium text-text">{lead.tenantDocument || "Não informado"}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">Remetente utilizado</dt>
              <dd className="font-medium text-text">
                {lead.senderPhoneE164 ? formatPhoneDisplay(lead.senderPhoneE164) : "Número padrão de suporte"}
              </dd>
            </div>
          </dl>

          <div className="mt-4 rounded-card bg-bg p-3 text-xs text-text-secondary">
            <div className="flex items-center gap-1.5 font-semibold text-text">
              <Info className="h-3.5 w-3.5 text-primary" />
              <span>Motivo da entrada na régua</span>
            </div>
            <p className="mt-1 leading-relaxed">
              O cliente cadastrou a empresa no formulário público e forneceu este WhatsApp para contato. A régua de resgate foi acionada porque o usuário ainda não realizou o primeiro acesso ao painel de gerenciamento.
            </p>
          </div>
        </Card>
      </div>

      {/* Linha do tempo dos disparos */}
      <Card className="border-border bg-surface p-5">
        <div className="mb-5 flex items-center justify-between border-b border-border pb-3">
          <div className="flex items-center gap-2 font-semibold text-text">
            <Clock className="h-4 w-4 text-primary" />
            <span>Linha do tempo do resgate</span>
          </div>
          <span className="text-xs text-text-muted">
            Próximo disparo programado: <strong className="text-text">{formatDate(lead.nextRunAt)}</strong>
          </span>
        </div>

        <ol className="relative space-y-6 border-l border-border pl-6">
          {/* 1. Cadastro inicial */}
          <li className="relative">
            <span className="absolute -left-[31px] flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary ring-4 ring-surface">
              <UserCheck className="h-3.5 w-3.5" />
            </span>
            <div className="text-sm font-semibold text-text">Cadastro inicial da empresa</div>
            <div className="text-xs text-text-muted">{formatDate(lead.createdAt)}</div>
            <p className="mt-1 text-xs text-text-secondary">
              Conta criada pelo formulário público. Entrada na régua agendada para 24 horas após o cadastro.
            </p>
          </li>

          {/* 2. Passo 1 */}
          <li className="relative">
            <span
              className={`absolute -left-[31px] flex h-6 w-6 items-center justify-center rounded-full ring-4 ring-surface ${
                lead.step1SentAt
                  ? "bg-success-bg text-success"
                  : "bg-warning-bg text-warning"
              }`}
            >
              <MessageSquare className="h-3.5 w-3.5" />
            </span>
            <div className="flex items-center gap-2 text-sm font-semibold text-text">
              <span>Passo 1: Mensagem de 24 horas</span>
              {lead.step1SentAt ? (
                <Badge variant="success">Enviada com sucesso</Badge>
              ) : (
                <Badge variant="warning">Agendada para {formatDate(lead.step1ScheduledAt)}</Badge>
              )}
            </div>
            <div className="text-xs text-text-muted">
              {lead.step1SentAt ? `Enviada em ${formatDate(lead.step1SentAt)}` : `Programada para ${formatDate(lead.step1ScheduledAt)}`}
            </div>
            {lead.providerMessageId1 && (
              <div className="mt-1 text-xs text-text-muted">
                ID no WhatsApp: <code className="rounded bg-bg px-1 py-0.5">{lead.providerMessageId1}</code>
              </div>
            )}
          </li>

          {/* 3. Passo 2 */}
          <li className="relative">
            <span
              className={`absolute -left-[31px] flex h-6 w-6 items-center justify-center rounded-full ring-4 ring-surface ${
                lead.step2SentAt
                  ? "bg-success-bg text-success"
                  : lead.step1SentAt
                  ? "bg-primary/10 text-primary"
                  : "bg-bg text-text-muted border border-border"
              }`}
            >
              <Send className="h-3.5 w-3.5" />
            </span>
            <div className="flex items-center gap-2 text-sm font-semibold text-text">
              <span>Passo 2: Mensagem de 96 horas (4º dia)</span>
              {lead.step2SentAt ? (
                <Badge variant="success">Enviada com sucesso</Badge>
              ) : lead.step2ScheduledAt ? (
                <Badge variant="neutral">Agendada para {formatDate(lead.step2ScheduledAt)}</Badge>
              ) : (
                <Badge variant="neutral">Aguardando passo 1</Badge>
              )}
            </div>
            <div className="text-xs text-text-muted">
              {lead.step2SentAt
                ? `Enviada em ${formatDate(lead.step2SentAt)}`
                : lead.step2ScheduledAt
                ? `Programada para ${formatDate(lead.step2ScheduledAt)}`
                : "Será agendada após o envio do passo 1"}
            </div>
            {lead.providerMessageId2 && (
              <div className="mt-1 text-xs text-text-muted">
                ID no WhatsApp: <code className="rounded bg-bg px-1 py-0.5">{lead.providerMessageId2}</code>
              </div>
            )}
          </li>

          {/* 4. Eventos de Resposta / Conversão / Opt-out */}
          {lead.respondedAt && (
            <li className="relative">
              <span className="absolute -left-[31px] flex h-6 w-6 items-center justify-center rounded-full bg-success-bg text-success ring-4 ring-surface">
                <CheckCircle2 className="h-3.5 w-3.5" />
              </span>
              <div className="text-sm font-semibold text-success">Cliente respondeu pelo WhatsApp</div>
              <div className="text-xs text-text-muted">{formatDate(lead.respondedAt)}</div>
              <p className="mt-1 text-xs text-text-secondary">
                O cliente respondeu às mensagens de resgate e abriu conversa no canal de suporte/atendimento.
              </p>
            </li>
          )}

          {lead.convertedAt && (
            <li className="relative">
              <span className="absolute -left-[31px] flex h-6 w-6 items-center justify-center rounded-full bg-success-bg text-success ring-4 ring-surface">
                <CheckCircle2 className="h-3.5 w-3.5" />
              </span>
              <div className="text-sm font-semibold text-success">Conversão confirmada</div>
              <div className="text-xs text-text-muted">{formatDate(lead.convertedAt)}</div>
              <p className="mt-1 text-xs text-text-secondary">
                O usuário acessou o painel da empresa, concluindo com êxito a jornada de resgate.
              </p>
            </li>
          )}

          {lead.optedOutAt && (
            <li className="relative">
              <span className="absolute -left-[31px] flex h-6 w-6 items-center justify-center rounded-full bg-neutral-bg text-text-secondary ring-4 ring-surface">
                <AlertCircle className="h-3.5 w-3.5" />
              </span>
              <div className="text-sm font-semibold text-text">Saída solicitada (Opt-out)</div>
              <div className="text-xs text-text-muted">{formatDate(lead.optedOutAt)}</div>
              <p className="mt-1 text-xs text-text-secondary">
                O cliente respondeu SAIR ou PARAR e foi removido de futuros disparos.
              </p>
            </li>
          )}

          {lead.lastErrorCode && (
            <li className="relative">
              <span className="absolute -left-[31px] flex h-6 w-6 items-center justify-center rounded-full bg-danger-bg text-danger ring-4 ring-surface">
                <AlertTriangle className="h-3.5 w-3.5" />
              </span>
              <div className="text-sm font-semibold text-danger">Última falha de envio</div>
              <div className="text-xs text-danger/80">
                Código do erro: <code className="font-mono">{lead.lastErrorCode}</code> ({lead.attempts} tentativa(s))
              </div>
            </li>
          )}
        </ol>
      </Card>

      {/* Histórico de Auditoria do Lead */}
      <Card className="border-border bg-surface p-5">
        <div className="mb-4 flex items-center justify-between border-b border-border pb-3">
          <div className="flex items-center gap-2 font-semibold text-text">
            <History className="h-4 w-4 text-primary" />
            <span>Histórico de auditoria deste lead</span>
          </div>
          <span className="text-xs text-text-muted">{lead.auditLogs.length} registro(s)</span>
        </div>

        {lead.auditLogs.length === 0 ? (
          <p className="text-xs text-text-muted">Nenhum evento registrado na auditoria até o momento.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-text-muted uppercase">
                <tr>
                  <th className="py-2 pr-3">Data</th>
                  <th className="py-2 pr-3">Autor</th>
                  <th className="py-2 pr-3">Ação</th>
                  <th className="py-2">Resumo / Justificativa</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {lead.auditLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-bg/40">
                    <td className="py-2.5 pr-3 text-text-muted whitespace-nowrap">
                      {formatDate(log.createdAt)}
                    </td>
                    <td className="py-2.5 pr-3 font-semibold text-text">
                      {log.actorRole === "PLATFORM_ADMIN"
                        ? "Administrador"
                        : log.actorRole === "SYSTEM"
                        ? "Sistema (Tick)"
                        : log.actorRole}
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-text-secondary">
                      {log.action}
                    </td>
                    <td className="py-2.5 text-text">
                      {log.summary}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Modal de Confirmação com Motivo */}
      <Dialog open={Boolean(activeAction)} onOpenChange={(open) => !open && closeAction()}>
        <DialogContent>
          <DialogHeader
            icon={
              activeAction === "pause"
                ? Pause
                : activeAction === "resume"
                ? Play
                : activeAction === "convert"
                ? CheckCircle2
                : RefreshCw
            }
            tone={
              activeAction === "pause"
                ? "warning"
                : activeAction === "convert"
                ? "success"
                : "primary"
            }
          >
            <DialogTitle>
              {activeAction === "pause" && "Pausar envios para este lead?"}
              {activeAction === "resume" && "Retomar envios para este lead?"}
              {activeAction === "convert" && "Marcar lead como convertido manualmente?"}
              {activeAction === "resend" && "Reenviar mensagem para este lead?"}
            </DialogTitle>
            <DialogDescription>
              {activeAction === "pause" &&
                "Isso interrompe as mensagens automáticas deste lead. Ele passará para o estado Pausado."
              }
              {activeAction === "resume" &&
                "O lead voltará para a fila ativa de resgate e receberá a próxima mensagem devida."
              }
              {activeAction === "convert" &&
                "Use esta ação se o cliente já começou a operar ou foi contatado com sucesso por outro canal."
              }
              {activeAction === "resend" &&
                "Zera as tentativas de falha e reagenda um envio imediato no próximo ciclo de disparo."
              }
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-3">
            <label htmlFor="action-reason" className="block text-xs font-semibold text-text">
              Motivo da alteração (obrigatório para auditoria):
            </label>
            <textarea
              id="action-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explique detalhadamente o motivo desta ação operacional (15 a 500 caracteres)..."
              className="w-full rounded-card border border-border bg-bg p-3 text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              rows={3}
              maxLength={500}
            />
            <div className="flex items-center justify-between text-xs text-text-muted">
              <span>Mínimo de 15 caracteres</span>
              <span className={reason.length < 15 ? "text-warning" : "text-text-muted"}>
                {reason.length}/500
              </span>
            </div>

            {actionError && (
              <Alert variant="danger" title="Não foi possível concluir a ação">
                {actionError}
              </Alert>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={closeAction} disabled={isSubmitting}>
              Cancelar
            </Button>
            <Button
              variant={
                activeAction === "pause"
                  ? "warning"
                  : activeAction === "convert"
                  ? "success"
                  : "primary"
              }
              size="sm"
              isLoading={isSubmitting}
              onClick={handleConfirmAction}
              disabled={reason.trim().length < 15 || isSubmitting}
            >
              Confirmar ação
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
