"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, ExternalLink, RefreshCw, Rocket, Undo2, Workflow, X, type LucideIcon } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, type DialogTone } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { formatDateTimeLabel } from "@/components/lib/format-date";
import {
  downloadLiveBotFlowAction,
  getBotFlowStatusAction,
  publishBotFlowAction,
  rollbackBotFlowAction,
} from "@/modules/platform/publish-actions";
import type { BotFlowStatus, PublishResult } from "@/modules/platform/n8n-publish";

type ActionResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; details?: unknown } };

/** As quatro Server Actions do card — injetáveis só para pré-visualizar/testar sem n8n. */
export type BotFlowActions = {
  getStatus: () => Promise<ActionResult<BotFlowStatus>>;
  publish: (input: { confirm?: "PUBLICAR" | "SOBRESCREVER" }) => Promise<ActionResult<PublishResult>>;
  rollback: (input: { confirm: "VOLTAR" }) => Promise<ActionResult<PublishResult>>;
  download: () => Promise<ActionResult<{ filename: string; json: string }>>;
};

const REAL_ACTIONS: BotFlowActions = {
  getStatus: getBotFlowStatusAction,
  publish: publishBotFlowAction,
  rollback: rollbackBotFlowAction,
  download: downloadLiveBotFlowAction,
};

/** Fuso fixo do admin da plataforma (o painel é da Innovare, não de uma empresa). */
const ADMIN_TZ = "America/Sao_Paulo";

type Confirm = "PUBLICAR" | "SOBRESCREVER" | "VOLTAR";
type Busy = "load" | "publish" | "rollback" | "download" | null;
type FlowError = { code: string; message: string; details?: unknown };

const DIALOG_COPY: Record<Confirm, { icon: LucideIcon; tone: DialogTone; title: string; description: string; action: string }> = {
  PUBLICAR: {
    icon: Rocket,
    tone: "primary",
    title: "Publicar o fluxo pela primeira vez",
    description:
      "O fluxo que está agora no n8n será substituído pelo do painel, para todas as empresas conectadas. Uma cópia do atual fica guardada para você poder voltar.",
    action: "Publicar fluxo",
  },
  SOBRESCREVER: {
    icon: Rocket,
    tone: "danger",
    title: "Sobrescrever o fluxo do n8n",
    description:
      "As edições feitas direto no n8n serão descartadas e o fluxo do painel entra no lugar. Baixe o fluxo atual antes se quiser guardar essas edições.",
    action: "Sobrescrever",
  },
  VOLTAR: {
    icon: Undo2,
    tone: "danger",
    title: "Voltar à versão anterior",
    description:
      "O n8n volta para a versão guardada antes da última publicação. Só dá para voltar 1 versão: depois disso não haverá outra para retornar.",
    action: "Voltar versão",
  },
};

/** Conteúdo do diálogo de confirmação digitada. Montado só com o diálogo aberto, então o campo
 * sempre nasce vazio (sem estado velho de uma confirmação anterior). */
function TypedConfirmBody({
  word,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  word: Confirm;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const copy = DIALOG_COPY[word];
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === word;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (matches && !busy) onConfirm();
      }}
    >
      <DialogHeader icon={copy.icon} tone={copy.tone}>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{copy.description}</DialogDescription>
      </DialogHeader>
      <div className="mt-4 flex flex-col gap-3">
        {error ? <Alert variant="danger">{error}</Alert> : null}
        <Field label={`Digite ${word} para confirmar`}>
          {(fieldProps) => (
            <Input
              {...fieldProps}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={word}
            />
          )}
        </Field>
      </div>
      <DialogFooter>
        <Button icon={X} type="button" variant="secondary" onClick={onCancel} disabled={busy}>
          Cancelar
        </Button>
        <Button
          icon={copy.icon}
          type="submit"
          variant={copy.tone === "danger" ? "danger" : "primary"}
          disabled={!matches}
          isLoading={busy}
          loadingText="Enviando ao n8n…"
        >
          {copy.action}
        </Button>
      </DialogFooter>
    </form>
  );
}

function FlowTile({ label, value, sub }: { label: string; value: string; sub?: string | null }) {
  return (
    <div className="min-w-0 rounded-hero border border-border bg-bg p-4">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className="mt-1 break-words font-display text-base font-bold text-text">{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-text-secondary">{sub}</p> : null}
    </div>
  );
}

const N8N_CONFIG_CODES = new Set(["N8N_NOT_CONFIGURED", "N8N_UNREACHABLE", "N8N_API_ERROR"]);
const N8N_SYNC_CODES = new Set(["N8N_NOT_SYNCED", "N8N_WORKFLOW_NOT_FOUND"]);

function detailString(details: unknown, key: string): string | null {
  if (details && typeof details === "object" && key in details) {
    const v = (details as Record<string, unknown>)[key];
    return typeof v === "string" && v ? v : null;
  }
  return null;
}

function AnchorButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Button asChild variant="secondary" size="sm" className="mt-3">
      <a href={href}>{children}</a>
    </Button>
  );
}

/** Erro de uma ação (publicar/voltar/baixar), com o tom certo para cada código. */
function FlowErrorAlert({ error }: { error: FlowError }) {
  const { code, message, details } = error;

  if (code === "WEBHOOK_PATH_CHANGED") {
    const livePath = detailString(details, "livePath");
    const newPath = detailString(details, "newPath");
    return (
      <Alert variant="warning" title="O caminho do webhook mudou">
        {message}
        {livePath && newPath ? (
          <span className="mt-1 block text-xs">
            No n8n: <code className="break-all">{livePath}</code> · No painel: <code className="break-all">{newPath}</code>
          </span>
        ) : null}
      </Alert>
    );
  }

  if (code === "PUBLISH_VERIFY_FAILED") {
    const restored = !!(details && typeof details === "object" && (details as { restored?: unknown }).restored === true);
    return restored ? (
      <Alert variant="warning" title="A publicação foi desfeita">
        {message}
      </Alert>
    ) : (
      <Alert variant="danger" title="Confira o n8n agora">
        {message} Abra o fluxo do bot no n8n e confirme que ele está íntegro antes de mexer em qualquer outra coisa.
      </Alert>
    );
  }

  if (N8N_CONFIG_CODES.has(code)) {
    return (
      <Alert variant="danger" title="Não deu para falar com o n8n">
        {message}
        <AnchorButton href="#n8n-config">
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
          Conferir a configuração do n8n
        </AnchorButton>
      </Alert>
    );
  }

  if (N8N_SYNC_CODES.has(code)) {
    return (
      <Alert variant="danger" title="O n8n ainda não está sincronizado">
        {message}
        <AnchorButton href="#bot-n8n">
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
          Ir para “Sincronizar n8n”
        </AnchorButton>
      </Alert>
    );
  }

  if (code === "NO_SNAPSHOT") {
    return (
      <Alert variant="warning" title="Não há versão anterior">
        {message}
      </Alert>
    );
  }

  return (
    <Alert variant="danger" title="Não foi possível concluir">
      {message}
    </Alert>
  );
}

export function BotFlowCard({ actions = REAL_ACTIONS }: { actions?: BotFlowActions }) {
  const { notify } = useToast();
  const actionsRef = useRef(actions);
  const [status, setStatus] = useState<BotFlowStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [dialog, setDialog] = useState<Confirm | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [flowError, setFlowError] = useState<FlowError | null>(null);
  const [notice, setNotice] = useState<{ variant: "success" | "info"; text: string } | null>(null);

  /** Recarrega o status. Nunca lança: o status "nunca falha" no servidor, mas a rede pode. */
  const load = useCallback(async () => {
    try {
      const result = await actionsRef.current.getStatus();
      if (result.ok) {
        setStatus(result.data);
        setLoadError(null);
      } else {
        setLoadError(result.error.message);
      }
    } catch {
      setLoadError("Falha de conexão ao consultar o fluxo do bot.");
    }
  }, []);

  useEffect(() => {
    // `setTimeout(0)`: o lint bloqueia setState síncrono em efeito; o cleanup cancela se desmontar.
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  async function reload() {
    setBusy("load");
    await load();
    setBusy(null);
  }

  function closeDialog() {
    if (busy) return;
    setDialog(null);
    setDialogError(null);
  }

  /** Publica; `confirm` vem do diálogo digitado (ou nada, na publicação comum). */
  async function publish(confirm?: "PUBLICAR" | "SOBRESCREVER") {
    setBusy("publish");
    setFlowError(null);
    setNotice(null);
    setDialogError(null);
    try {
      const result = await actionsRef.current.publish(confirm ? { confirm } : {});
      if (result.ok) {
        const unchanged = !confirm && !result.data.rolledBack && result.data.hash === status?.publishedHash;
        setDialog(null);
        if (unchanged) {
          setNotice({ variant: "info", text: "Já está atualizado: o n8n já roda exatamente a versão do sistema." });
        } else {
          setNotice({ variant: "success", text: `Fluxo publicado: versão ${result.data.version} no ar no n8n.` });
          notify({ variant: "success", title: "Fluxo publicado." });
        }
      } else if (result.error.code === "CONFIRMATION_REQUIRED") {
        setDialogError(null);
        setDialog("PUBLICAR");
      } else if (result.error.code === "FLOW_DRIFT") {
        setDialog(null);
        setFlowError(null); // o alerta de drift vem do status recarregado abaixo
      } else if (dialog) {
        setDialogError(result.error.message);
      } else {
        setFlowError(result.error);
      }
    } catch {
      setFlowError({ code: "NETWORK", message: "Falha de conexão. Confira o status antes de tentar de novo." });
      setDialog(null);
    } finally {
      await load();
      setBusy(null);
    }
  }

  async function rollback() {
    setBusy("rollback");
    setFlowError(null);
    setNotice(null);
    setDialogError(null);
    try {
      const result = await actionsRef.current.rollback({ confirm: "VOLTAR" });
      if (result.ok) {
        setDialog(null);
        setNotice({ variant: "success", text: `Voltou para a versão ${result.data.version}.` });
        notify({ variant: "success", title: "Versão anterior restaurada." });
      } else {
        setDialog(null);
        setFlowError(result.error);
      }
    } catch {
      setDialog(null);
      setFlowError({ code: "NETWORK", message: "Falha de conexão. Confira o status antes de tentar de novo." });
    } finally {
      await load();
      setBusy(null);
    }
  }

  async function download() {
    setBusy("download");
    setFlowError(null);
    try {
      const result = await actionsRef.current.download();
      if (!result.ok) {
        setFlowError(result.error);
        return;
      }
      const blob = new Blob([result.data.json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.data.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setFlowError({ code: "NETWORK", message: "Falha de conexão ao baixar o fluxo." });
    } finally {
      setBusy(null);
    }
  }

  const s = status;
  const upToDate = !!s && s.n8nReachable && !s.drift && !s.firstPublish && !s.updateAvailable;
  const anyBusy = busy !== null;

  let headBadge: React.ReactNode = null;
  if (s) {
    if (!s.n8nReachable) headBadge = <Badge variant="danger">n8n sem resposta</Badge>;
    else if (s.drift) headBadge = <Badge variant="warning">Editado no n8n</Badge>;
    else if (s.firstPublish) headBadge = <Badge variant="neutral">Nunca publicado</Badge>;
    else if (s.updateAvailable) headBadge = <Badge variant="primary">Nova versão disponível</Badge>;
    else headBadge = <Badge variant="success">Já está atualizado</Badge>;
  }

  return (
    <Card className="rounded-hero" id="bot-flow" data-testid="bot-flow-card">
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-[16rem] flex-1 items-start gap-3">
          <span
            aria-hidden="true"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-card bg-primary/10 text-primary"
          >
            <Workflow className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <CardTitle>Fluxo do bot</CardTitle>
            <CardDescription>
              Coloca no n8n a versão do fluxo que veio com o sistema, sem mexer nas credenciais nem no endereço do webhook.
            </CardDescription>
          </div>
        </div>
        {headBadge}
      </CardHeader>

      <CardContent className="flex flex-col gap-4" aria-busy={!s && !loadError ? true : undefined}>
        {!s && !loadError ? (
          <div className="grid gap-3 sm:grid-cols-3" role="status" aria-label="Carregando o status do fluxo">
            <Skeleton className="h-24 rounded-hero" />
            <Skeleton className="h-24 rounded-hero" />
            <Skeleton className="h-24 rounded-hero" />
          </div>
        ) : null}

        {loadError && !s ? (
          <Alert variant="danger" title="Não deu para carregar o status do fluxo">
            {loadError}
          </Alert>
        ) : null}

        {s ? (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <FlowTile label="Versão do sistema" value={s.buildVersion} sub={`Assinatura ${s.buildHash.slice(0, 8)}`} />
              <FlowTile
                label="Versão publicada no n8n"
                value={s.publishedVersion ?? "Nunca publicada"}
                sub={s.publishedHash ? `Assinatura ${s.publishedHash.slice(0, 8)}` : null}
              />
              <FlowTile
                label="Publicada em"
                value={s.publishedAt ? formatDateTimeLabel(s.publishedAt, ADMIN_TZ) : "—"}
                sub={s.publishedAt ? "Horário de Brasília" : null}
              />
            </div>

            {!s.n8nReachable ? (
              <Alert variant="danger" title="Não deu para falar com o n8n">
                {s.error ?? "O n8n não respondeu."}
                <AnchorButton href="#n8n-config">
                  <ExternalLink className="h-4 w-4" aria-hidden="true" />
                  Conferir a configuração do n8n
                </AnchorButton>
              </Alert>
            ) : null}

            {s.n8nReachable && s.drift ? (
              <Alert variant="warning" title="Alguém editou o fluxo direto no n8n">
                O fluxo que está no n8n é diferente do último que o painel publicou. Publicar de novo descarta essas edições.
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    icon={Download}
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={download}
                    isLoading={busy === "download"}
                    loadingText="Baixando…"
                    disabled={anyBusy && busy !== "download"}
                  >
                    Baixar o fluxo atual
                  </Button>
                  <Button
                    icon={Rocket}
                    type="button"
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      setDialogError(null);
                      setDialog("SOBRESCREVER");
                    }}
                    disabled={anyBusy}
                  >
                    Sobrescrever
                  </Button>
                </div>
              </Alert>
            ) : null}

            {s.n8nReachable && s.firstPublish ? (
              <Alert variant="info" title="Ainda não foi publicado por aqui">
                O n8n roda o fluxo original. Na primeira publicação o painel guarda uma cópia dele, para você poder voltar.
              </Alert>
            ) : null}

            {upToDate ? (
              <Alert variant="success" title="Já está atualizado">
                O n8n roda a versão {s.buildVersion}, a mesma que veio com o sistema.
              </Alert>
            ) : null}

            {s.n8nReachable && !s.drift && !s.firstPublish && s.updateAvailable ? (
              <Alert variant="info" title="Nova versão disponível">
                O sistema traz a versão {s.buildVersion}; o n8n está na {s.publishedVersion ?? "original"}.
              </Alert>
            ) : null}

            {s.canRollback ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-hero border border-border bg-bg p-4">
                <div className="min-w-0 flex-1 basis-64">
                  <p className="text-sm font-semibold text-text">
                    Versão anterior guardada{s.previousVersion ? `: ${s.previousVersion}` : ""}
                  </p>
                  <p className="mt-0.5 text-xs text-text-secondary">
                    Dá para voltar só 1 versão. Depois de voltar, não há outra guardada para retornar.
                  </p>
                </div>
                <Button
                  icon={Undo2}
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setDialogError(null);
                    setDialog("VOLTAR");
                  }}
                  disabled={anyBusy || !s.n8nReachable}
                >
                  Voltar à versão anterior
                </Button>
              </div>
            ) : null}
          </>
        ) : null}

        {notice ? (
          <Alert variant={notice.variant} role="status">
            {notice.text}
          </Alert>
        ) : null}
        {flowError ? <FlowErrorAlert error={flowError} /> : null}
      </CardContent>

      <CardFooter className="flex-wrap">
        {s && !s.drift ? (
          <Button
            icon={Rocket}
            type="button"
            onClick={() => (s.firstPublish ? (setDialogError(null), setDialog("PUBLICAR")) : void publish())}
            isLoading={busy === "publish" && !dialog}
            loadingText="Publicando…"
            disabled={upToDate || !s.n8nReachable || (anyBusy && busy !== "publish")}
          >
            Publicar fluxo
          </Button>
        ) : null}
        <Button
          icon={RefreshCw}
          type="button"
          variant="secondary"
          onClick={reload}
          isLoading={busy === "load"}
          loadingText="Consultando…"
          disabled={anyBusy && busy !== "load"}
        >
          Consultar de novo
        </Button>
      </CardFooter>

      {/* Sempre montado; só o conteúdo (com o campo digitado) nasce e morre com `open`. */}
      <Dialog open={dialog !== null} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent>
          {dialog ? (
            <TypedConfirmBody
              word={dialog}
              busy={busy === "publish" || busy === "rollback"}
              error={dialogError}
              onCancel={closeDialog}
              onConfirm={() => (dialog === "VOLTAR" ? void rollback() : void publish(dialog))}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
