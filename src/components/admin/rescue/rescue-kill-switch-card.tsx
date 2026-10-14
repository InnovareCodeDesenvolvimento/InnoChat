"use client";

import { useState } from "react";
import { CheckCircle2, Power, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { HelpButton } from "@/components/help/help-button";
import { useToast } from "@/components/ui/toast";
import { toggleRescueEnabledAction } from "@/modules/rescue/admin-actions";

export type RescueKillSwitchCardProps = {
  initialEnabled: boolean;
  onToggleSuccess?: (enabled: boolean) => void;
};

export function RescueKillSwitchCard({ initialEnabled, onToggleSuccess }: RescueKillSwitchCardProps) {
  const { notify } = useToast();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [modalOpen, setModalOpen] = useState(false);
  const [targetState, setTargetState] = useState(!initialEnabled);
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  function openConfirm(nextState: boolean) {
    setTargetState(nextState);
    setReason("");
    setErrorMsg(null);
    setModalOpen(true);
  }

  async function handleConfirm() {
    if (reason.trim().length < 15) {
      setErrorMsg("O motivo precisa ter pelo menos 15 caracteres.");
      return;
    }
    if (reason.trim().length > 500) {
      setErrorMsg("O motivo pode ter no máximo 500 caracteres.");
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const res = await toggleRescueEnabledAction(targetState, reason.trim());
      if (!res.ok) {
        setErrorMsg(res.error.message);
        notify({
          variant: "error",
          title: "Não foi possível alterar o estado",
          description: res.error.message,
        });
        return;
      }

      setEnabled(res.data.enabled);
      setModalOpen(false);
      notify({
        variant: "success",
        title: res.data.enabled ? "Régua ativada com sucesso" : "Régua pausada globalmente",
        description: res.data.enabled
          ? "Os envios automáticos de resgate foram retomados."
          : "Nenhuma mensagem de resgate será enviada enquanto estiver pausada.",
      });
      onToggleSuccess?.(res.data.enabled);
    } catch {
      setErrorMsg("Falha de conexão ao comunicar com o servidor.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Card className="border-border bg-surface">
      <CardHeader className="flex flex-row items-start justify-between gap-4 pb-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <CardTitle className="text-base font-bold text-text">Régua de resgate de leads via WhatsApp</CardTitle>
            <Badge variant={enabled ? "success" : "danger"}>
              {enabled ? "Ativa no momento" : "Pausada globalmente"}
            </Badge>
          </div>
          <CardDescription className="text-sm text-text-secondary">
            Dispara mensagens de acolhimento em 24h e 96h para quem concluiu o cadastro mas ainda não acessou o painel da empresa.
          </CardDescription>
        </div>
        <HelpButton helpKey="admin.resgateKillSwitch" />
      </CardHeader>

      <CardContent className="space-y-3 pt-0 text-sm text-text-secondary">
        <p>
          {enabled
            ? "A régua está em funcionamento normal. O sistema avalia os cadastros periodicamente e dispara pelo número dedicado de suporte/resgate nos horários permitidos (fora da janela de silêncio)."
            : "Atenção: o kill switch global está acionado. Nenhum envio de resgate é feito enquanto a régua estiver desligada. Os cadastros continuam sendo registrados para você poder retomar quando desejar."}
        </p>
      </CardContent>

      <CardFooter className="flex items-center justify-between border-t border-border pt-4">
        <span className="text-xs text-text-muted">
          {enabled ? "Para suspender envios temporariamente:" : "Para restabelecer os envios normais:"}
        </span>
        <Button
          variant={enabled ? "danger" : "primary"}
          size="sm"
          icon={Power}
          onClick={() => openConfirm(!enabled)}
        >
          {enabled ? "Pausar régua (Kill switch)" : "Ativar régua de resgate"}
        </Button>
      </CardFooter>

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent>
          <DialogHeader
            icon={targetState ? CheckCircle2 : ShieldAlert}
            tone={targetState ? "success" : "danger"}
          >
            <DialogTitle>
              {targetState ? "Ativar régua de resgate?" : "Pausar toda a régua de resgate?"}
            </DialogTitle>
            <DialogDescription>
              {targetState
                ? "A régua voltará a enviar mensagens pelo WhatsApp nos horários programados para todos os leads pendentes."
                : "Tem certeza? Isso pausa TODA a régua de resgate de todos os clientes cadastrados na plataforma, não apenas a próxima mensagem."}
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-3">
            <label htmlFor="kill-switch-reason" className="block text-xs font-semibold text-text">
              Motivo da alteração (obrigatório para auditoria):
            </label>
            <textarea
              id="kill-switch-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explique detalhadamente por que está alterando o estado global do resgate (15 a 500 caracteres)..."
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

            {errorMsg && (
              <Alert variant="danger" title="Não foi possível alterar a régua">
                {errorMsg}
              </Alert>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setModalOpen(false)} disabled={isSubmitting}>
              Cancelar
            </Button>
            <Button
              variant={targetState ? "primary" : "danger"}
              size="sm"
              isLoading={isSubmitting}
              onClick={handleConfirm}
              disabled={reason.trim().length < 15 || isSubmitting}
            >
              {targetState ? "Confirmar ativação" : "Confirmar pausa global"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
