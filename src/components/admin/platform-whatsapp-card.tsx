"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Link2Off, MessageCircle, QrCode, RefreshCw, Send, Smartphone } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { HelpButton } from "@/components/help/help-button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import {
  cancelPlatformWhatsappConnectionAction,
  disconnectPlatformWhatsappAction,
  getPlatformWhatsappAction,
  getPlatformWhatsappQrAction,
  sendPlatformWhatsappTestAction,
  setPlatformWhatsappEnabledAction,
  startPlatformWhatsappConnectionAction,
  type PlatformQrView,
  type PlatformWhatsappState,
} from "@/modules/platform/platform-whatsapp-actions";

/**
 * Card "WhatsApp de cobrança" (Admin > Configurações; docs/regua-de-cobranca.md §2.4). Separado do card
 * do WhatsApp comercial do site. Fluxos: conectar, trocar (a ativa segue enviando até a nova conectar),
 * cancelar a troca, desconectar (digitando DESCONECTAR), reconectar a que caiu e enviar teste.
 */

const POLL_MS = 3000;

const RETIRED_LABEL: Record<string, string> = {
  REPLACED: "Trocado por outro número",
  DISCONNECTED_BY_ADMIN: "Desconectado por você",
  ABANDONED_QR: "QR não lido",
};

const TEST_ERROR: Record<string, string> = {
  NO_PLATFORM_NUMBER: "Não há número de cobrança conectado.",
  CHANNEL_DOWN: "O número caiu. Reconecte antes de testar.",
  BLOCKED_LOOP: "Esse é um número da própria plataforma. Digite o seu celular.",
  SEND_FAILED: "O WhatsApp não aceitou a mensagem agora. Tente de novo em instantes.",
  INVALID_NUMBER: "Digite o celular com DDD, por exemplo (84) 99999-8888.",
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

type QrTarget = { connectionId: string; kind: "connect" | "swap" | "reconnect" };

/** Polling do QR (3 s) enquanto `target` existir e a aba estiver visível. */
function usePlatformQr(target: QrTarget | null, onConnected: (phoneDisplay: string | null) => void, onGone: (message: string) => void) {
  const [view, setView] = useState<PlatformQrView | null>(null);
  const [failed, setFailed] = useState(false);
  const connectedRef = useRef(onConnected);
  const goneRef = useRef(onGone);
  useEffect(() => {
    connectedRef.current = onConnected;
    goneRef.current = onGone;
  });

  const connectionId = target?.connectionId ?? null;
  useEffect(() => {
    if (!connectionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) {
        timer = setTimeout(tick, POLL_MS);
        return;
      }
      const result = await getPlatformWhatsappQrAction(connectionId);
      if (cancelled) return;
      if (!result.ok) {
        if (result.error.code === "INVALID_STATE" || result.error.code === "NOT_FOUND" || result.error.code === "PHONE_IS_SALES_NUMBER" || result.error.code === "PHONE_IN_USE_BY_TENANT") {
          goneRef.current(result.error.message);
          return;
        }
        setFailed(true);
      } else {
        setFailed(false);
        setView(result.data);
        if (result.data.status === "CONNECTED") {
          connectedRef.current(result.data.phoneDisplay);
          return;
        }
      }
      timer = setTimeout(tick, POLL_MS);
    }

    // `setTimeout(0)`: mesma razão de `react-hooks/set-state-in-effect` registrada no projeto.
    timer = setTimeout(tick, 0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [connectionId]);

  return { view: connectionId ? view : null, failed };
}

export function PlatformWhatsappCard({ initialState }: { initialState: PlatformWhatsappState | null }) {
  const { notify } = useToast();
  const [state, setState] = useState<PlatformWhatsappState | null>(initialState);
  const [busy, setBusy] = useState(false);
  const [labelOpen, setLabelOpen] = useState(false);
  const [label, setLabel] = useState("Cobrança");
  const [qrTarget, setQrTarget] = useState<QrTarget | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [testOpen, setTestOpen] = useState(false);
  const [testPhone, setTestPhone] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const refresh = useCallback(async () => {
    const result = await getPlatformWhatsappAction();
    if (result.ok) setState(result.data);
  }, []);

  const qr = usePlatformQr(
    qrTarget,
    (phone) => {
      setQrTarget(null);
      notify({ variant: "success", title: "Número conectado.", description: phone ? `Os avisos de cobrança saem por ${phone}.` : undefined });
      void refresh();
    },
    (message) => {
      setQrTarget(null);
      notify({ variant: "error", title: "A conexão foi encerrada", description: message });
      void refresh();
    },
  );

  async function run<T>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: { code: string; message: string } }>, onOk: (data: T) => void | Promise<void>) {
    setBusy(true);
    try {
      const result = await fn();
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível concluir", description: result.error.message });
        return;
      }
      await onOk(result.data);
    } catch {
      notify({ variant: "error", title: "Falha de conexão", description: "Tente de novo em instantes." });
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(next: boolean) {
    await run(
      () => setPlatformWhatsappEnabledAction({ enabled: next }),
      async () => {
        notify({ variant: "success", title: next ? "Avisos por WhatsApp ligados." : "Avisos por WhatsApp desligados." });
        await refresh();
      },
    );
  }

  async function startConnection() {
    const swap = Boolean(state?.active);
    await run(
      () => startPlatformWhatsappConnectionAction({ label }),
      async (data) => {
        setLabelOpen(false);
        setQrTarget({ connectionId: data.connectionId, kind: swap ? "swap" : "connect" });
        await refresh();
      },
    );
  }

  async function cancelSwap(connectionId: string) {
    await run(
      () => cancelPlatformWhatsappConnectionAction(connectionId),
      async () => {
        setQrTarget(null);
        notify({ variant: "success", title: "Troca cancelada. O número atual segue enviando." });
        await refresh();
      },
    );
  }

  async function disconnect() {
    await run(
      () => disconnectPlatformWhatsappAction({ confirm: "DESCONECTAR" }),
      async () => {
        setDisconnectOpen(false);
        setConfirmText("");
        notify({ variant: "success", title: "Número desconectado.", description: "Os avisos passam a ir só por e-mail e pelo painel." });
        await refresh();
      },
    );
  }

  async function sendTest() {
    setTestResult(null);
    await run(
      () => sendPlatformWhatsappTestAction({ toE164: testPhone }),
      (data) => {
        setTestResult(data.sent ? { ok: true, message: "Mensagem enviada. Confira o seu celular." } : { ok: false, message: TEST_ERROR[data.errorCode ?? "SEND_FAILED"] ?? "Não foi possível enviar." });
      },
    );
  }

  if (!state) {
    return (
      <Card className="rounded-hero">
        <CardHeader>
          <CardTitle>WhatsApp de cobrança</CardTitle>
          <CardDescription>Não deu para carregar agora. Atualize a página.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const { active, pending } = state;
  const qrOpen = qrTarget !== null;
  const swapTitle = qrTarget?.kind === "swap" ? "Ler o QR do número novo" : qrTarget?.kind === "reconnect" ? "Reconectar o número de cobrança" : "Conectar o número de cobrança";

  return (
    <Card id="whatsapp-cobranca" className="rounded-hero">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <MessageCircle className="mt-1 h-5 w-5 text-primary" aria-hidden="true" />
          <div>
            <CardTitle className="flex items-center gap-2">
              WhatsApp de cobrança
              <HelpButton helpKey="admin.whatsappCobranca" />
            </CardTitle>
            <CardDescription>O número que avisa os assinantes sobre a mensalidade. Não é o WhatsApp comercial do site.</CardDescription>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={state.enabled ? "success" : "neutral"}>{state.enabled ? "Ligado" : "Desligado"}</Badge>
          <Switch checked={state.enabled} onCheckedChange={(next) => void toggleEnabled(next)} disabled={busy} aria-label="Mandar avisos de cobrança pelo WhatsApp" />
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {state.enabled ? null : <p className="text-sm text-text-secondary">Desligado: os avisos de cobrança vão só por e-mail e pelo painel.</p>}
        {state.enabled && !active ? <Alert variant="warning">Nenhum número conectado. Os avisos de cobrança estão indo só por e-mail e pelo painel.</Alert> : null}

        {active ? (
          <div className="flex flex-col gap-3 rounded-card border border-border bg-bg p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Smartphone className="h-5 w-5 text-text-secondary" aria-hidden="true" />
                <span className="text-base font-semibold text-text">{active.phoneDisplay ?? active.label}</span>
                <span className="text-sm text-text-secondary">({active.label})</span>
              </div>
              <Badge variant={active.status === "CONNECTED" ? "success" : "danger"}>{active.status === "CONNECTED" ? "Conectado" : "Caiu"}</Badge>
            </div>
            <p className="text-xs text-text-secondary">
              Ativo desde {formatDateTime(active.activatedAt)}.
              {active.inWarmup ? ` Número novo: no máximo ${active.roundCap} avisos por hora nos 3 primeiros dias.` : ""}
              {active.status === "DISCONNECTED" && active.disconnectedAt ? ` Caiu em ${formatDateTime(active.disconnectedAt)}.` : ""}
            </p>
            <div className="flex flex-col gap-1 text-xs text-text-secondary" data-testid="platform-whatsapp-diagnostics">
              <p>
                Última mensagem recebida:{" "}
                {active.diagnostics.lastInboundAt
                  ? `${formatDateTime(active.diagnostics.lastInboundAt)}${active.diagnostics.lastInboundFrom ? ` (${active.diagnostics.lastInboundFrom})` : ""}`
                  : "nenhuma ainda"}
              </p>
              <p>Última resposta automática: {active.diagnostics.lastAutoreplyAt ? formatDateTime(active.diagnostics.lastAutoreplyAt) : "nenhuma ainda"}</p>
              {active.diagnostics.notRepliedReason ? (
                <p className="font-medium text-warning">A última mensagem recebida ficou sem resposta ({active.diagnostics.notRepliedReason.replace(/^não respondeu: /, "")}).</p>
              ) : null}
              {active.diagnostics.webhookNote ? <p className="font-medium text-warning">{active.diagnostics.webhookNote}.</p> : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {active.status === "DISCONNECTED" ? (
                <Button type="button" size="sm" onClick={() => setQrTarget({ connectionId: active.id, kind: "reconnect" })} disabled={busy}>
                  <RefreshCw className="h-4 w-4" aria-hidden="true" /> Reconectar
                </Button>
              ) : null}
              <Button type="button" size="sm" variant="secondary" onClick={() => { setTestResult(null); setTestOpen(true); }} disabled={busy || active.status !== "CONNECTED"}>
                <Send className="h-4 w-4" aria-hidden="true" /> Enviar teste
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => { setLabel("Cobrança"); setLabelOpen(true); }} disabled={busy || pending !== null}>
                Trocar de número
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => { setConfirmText(""); setDisconnectOpen(true); }} disabled={busy}>
                Desconectar
              </Button>
            </div>
          </div>
        ) : null}

        {pending ? (
          <div className="flex flex-col gap-3 rounded-card border border-border bg-bg p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-text">{active ? "Troca em andamento" : "Conexão em andamento"}: {pending.label}</span>
              <Badge variant="warning">Esperando o QR</Badge>
            </div>
            {active ? <p className="text-xs text-text-secondary">O número atual segue enviando até o novo conectar.</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={() => setQrTarget({ connectionId: pending.id, kind: active ? "swap" : "connect" })} disabled={busy}>
                <QrCode className="h-4 w-4" aria-hidden="true" /> Mostrar QR
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => void cancelSwap(pending.id)} disabled={busy}>
                {active ? "Cancelar a troca" : "Cancelar"}
              </Button>
            </div>
          </div>
        ) : null}

        {!active && !pending ? (
          <div>
            <Button type="button" onClick={() => { setLabel("Cobrança"); setLabelOpen(true); }} disabled={busy}>
              <QrCode className="h-4 w-4" aria-hidden="true" /> Conectar número
            </Button>
          </div>
        ) : null}

        {state.history.length > 0 ? (
          <div>
            <h3 className="text-sm font-semibold text-text">Números anteriores</h3>
            <ul className="mt-2 flex flex-col gap-2">
              {state.history.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-border px-3 py-2 text-sm">
                  <span className="text-text">{item.phoneDisplay ?? item.label} <span className="text-text-secondary">({item.label})</span></span>
                  <span className="text-xs text-text-secondary">
                    {RETIRED_LABEL[item.retiredReason] ?? "Encerrado"} em {formatDateTime(item.retiredAt)} · {item.noticesSent} aviso(s) enviado(s)
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>

      <Dialog open={labelOpen} onOpenChange={(next) => (busy ? undefined : setLabelOpen(next))}>
        <DialogContent>
          <DialogHeader icon={Smartphone}>
            <DialogTitle>{active ? "Trocar de número" : "Conectar número"}</DialogTitle>
            <DialogDescription>
              {active ? "O número atual continua enviando até o novo conectar." : "Use um chip só para os avisos de cobrança."} Dê um nome para reconhecer depois.
            </DialogDescription>
          </DialogHeader>
          <Field label="Nome do número" hint="Por exemplo: Cobrança ou Cobrança (chip novo).">
            {(fieldProps) => <Input {...fieldProps} value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} />}
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setLabelOpen(false)} disabled={busy}>Voltar</Button>
            <Button type="button" onClick={() => void startConnection()} disabled={busy || label.trim().length === 0}>Gerar QR</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={qrOpen} onOpenChange={(next) => { if (!next) { setQrTarget(null); void refresh(); } }}>
        <DialogContent>
          <DialogHeader icon={QrCode}>
            <DialogTitle>{swapTitle}</DialogTitle>
            <DialogDescription>No celular do chip, abra o WhatsApp, vá em Aparelhos conectados e leia o QR abaixo.</DialogDescription>
          </DialogHeader>
          <div className="flex min-h-[288px] items-center justify-center">
            {qr.view?.qrBase64 ? (
              <div className="rounded-hero border border-border bg-white p-4 shadow-card">
                {/* eslint-disable-next-line @next/next/no-img-element -- QR em base64 gerado em runtime pela Evolution */}
                <img src={qr.view.qrBase64} alt="QR code para conectar o WhatsApp de cobrança" width={256} height={256} className="h-64 w-64" />
              </div>
            ) : (
              <p className="text-sm text-text-secondary" role="status">{qr.failed ? "Não deu para atualizar o QR agora. Tentando de novo…" : "Gerando o QR…"}</p>
            )}
          </div>
          <DialogFooter>
            {qrTarget?.kind !== "reconnect" && qrTarget ? (
              <Button type="button" variant="ghost" onClick={() => void cancelSwap(qrTarget.connectionId)} disabled={busy}>
                {qrTarget.kind === "swap" ? "Cancelar a troca" : "Cancelar"}
              </Button>
            ) : null}
            <Button type="button" variant="secondary" onClick={() => { setQrTarget(null); void refresh(); }}>Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={disconnectOpen} onOpenChange={(next) => (busy ? undefined : setDisconnectOpen(next))}>
        <DialogContent>
          <DialogHeader icon={Link2Off} tone="danger">
            <DialogTitle>Desconectar o número de cobrança?</DialogTitle>
            <DialogDescription>Os avisos passam a ir só por e-mail e pelo painel, até você conectar outro número.</DialogDescription>
          </DialogHeader>
          <Field label="Para confirmar, digite DESCONECTAR">
            {(fieldProps) => <Input {...fieldProps} value={confirmText} autoComplete="off" onChange={(e) => setConfirmText(e.target.value)} />}
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setDisconnectOpen(false)} disabled={busy}>Voltar</Button>
            <Button type="button" variant="danger" onClick={() => void disconnect()} disabled={busy || confirmText.trim() !== "DESCONECTAR"}>Desconectar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={testOpen} onOpenChange={(next) => (busy ? undefined : setTestOpen(next))}>
        <DialogContent>
          <DialogHeader icon={Send}>
            <DialogTitle>Enviar mensagem de teste</DialogTitle>
            <DialogDescription>Manda uma mensagem curta do número de cobrança para o celular que você digitar.</DialogDescription>
          </DialogHeader>
          <Field label="Seu celular com DDD" hint="Exemplo: (84) 99999-8888.">
            {(fieldProps) => <Input {...fieldProps} inputMode="tel" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} />}
          </Field>
          {testResult ? <Alert variant={testResult.ok ? "success" : "danger"}>{testResult.message}</Alert> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setTestOpen(false)} disabled={busy}>Fechar</Button>
            <Button type="button" onClick={() => void sendTest()} disabled={busy || testPhone.trim().length < 8}>Enviar teste</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
