"use client";

import { useState, useTransition } from "react";
import { Power, PowerOff, RefreshCw, X } from "lucide-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { activateBotWorkflowAction, deactivateBotWorkflowAction, syncN8nAction } from "@/modules/platform/actions";
import type { N8nSyncSummary } from "@/modules/platform/n8n-sync";

export function BotN8nCard() {
  const { notify } = useToast();
  const [isPending, startTransition] = useTransition();
  const [syncSummary, setSyncSummary] = useState<N8nSyncSummary | null>(null);
  const [botActive, setBotActive] = useState<boolean | null>(null);
  const [confirmActivate, setConfirmActivate] = useState<"on" | "off" | null>(null);

  function handleSyncN8n() {
    setSyncSummary(null);
    startTransition(async () => {
      const result = await syncN8nAction();
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível sincronizar o n8n", description: result.error.message });
        return;
      }
      setSyncSummary(result.data);
      setBotActive(null); // sync nunca ativa/desativa — status volta a "não verificado"
      notify({ variant: "success", title: "n8n sincronizado." });
    });
  }

  function handleToggleBot(activate: boolean) {
    startTransition(async () => {
      const result = activate ? await activateBotWorkflowAction() : await deactivateBotWorkflowAction();
      if (!result.ok) {
        notify({
          variant: "error",
          title: activate ? "Não foi possível ativar o bot" : "Não foi possível desativar o bot",
          description: result.error.message,
        });
        setConfirmActivate(null);
        return;
      }
      setBotActive(activate);
      notify({ variant: "success", title: activate ? "Bot ativado." : "Bot desativado." });
      setConfirmActivate(null);
    });
  }

  return (
    <>
      <Card id="bot-n8n" className="rounded-hero">
        <CardHeader>
          <CardTitle>Bot no n8n</CardTitle>
          <CardDescription>
            Leva a URL do painel, a URL da Evolution e as credenciais para o workflow do bot. A sincronização
            nunca ativa o bot.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Badge variant={botActive === null ? "neutral" : botActive ? "success" : "danger"}>
              {botActive === null ? "Status não verificado" : botActive ? "Bot ativo" : "Bot inativo"}
            </Badge>
          </div>
          {syncSummary ? (
            <Alert variant="success">
              Sincronizado: {syncSummary.credentialsRotated} credencial(is) rotacionada(s), {syncSummary.nodesRebound}{" "}
              nó(s) reconectado(s). Workflow do bot: <code className="text-xs">{syncSummary.botWorkflowId}</code>. Webhook
              reapontado em {syncSummary.webhooksReapontados} número(s) de WhatsApp
              {syncSummary.webhooksFalhos > 0 ? `, ${syncSummary.webhooksFalhos} com falha` : ""}.
              {syncSummary.warnings.map((w) => (
                <span key={w} className="block">
                  {w}
                </span>
              ))}
            </Alert>
          ) : null}
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" onClick={handleSyncN8n} isLoading={isPending}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Sincronizar n8n
          </Button>
          <Button type="button" variant="secondary" onClick={() => setConfirmActivate("on")} disabled={isPending}>
            <Power className="h-4 w-4" aria-hidden="true" />
            Ativar bot
          </Button>
          <Button type="button" variant="danger" onClick={() => setConfirmActivate("off")} disabled={isPending}>
            <PowerOff className="h-4 w-4" aria-hidden="true" />
            Desativar bot
          </Button>
        </CardFooter>
      </Card>

      <Dialog open={!!confirmActivate} onOpenChange={(open) => !open && setConfirmActivate(null)}>
        <DialogContent>
          <DialogHeader icon={confirmActivate === "on" ? Power : PowerOff} tone={confirmActivate === "on" ? "primary" : "danger"}>
            <DialogTitle>{confirmActivate === "on" ? "Ativar o bot" : "Desativar o bot"}</DialogTitle>
            <DialogDescription>
              {confirmActivate === "on"
                ? "O workflow do bot passa a responder no WhatsApp de todas as empresas conectadas. Sincronize o n8n antes, se ainda não sincronizou."
                : "O workflow do bot deixa de responder no WhatsApp de todas as empresas conectadas."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button icon={X} type="button" variant="secondary" onClick={() => setConfirmActivate(null)}>
              Cancelar
            </Button>
            <Button
              icon={confirmActivate === "on" ? Power : PowerOff}
              type="button"
              variant={confirmActivate === "off" ? "danger" : "primary"}
              onClick={() => handleToggleBot(confirmActivate === "on")}
              isLoading={isPending}
             loadingText="Confirmando…">
              Confirmar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
