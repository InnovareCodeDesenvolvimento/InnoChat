"use client";

import { useState } from "react";
import { Bot, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { closeAttendanceAction } from "@/modules/attendance/actions";

/**
 * Confirmação de "Encerrar e devolver ao bot". Tom primary (não é destrutivo: a conversa continua
 * guardada, só o bot volta a responder). `open` vive no PAI; o estado de envio é interno e nunca
 * fica amarrado a uma condição que a própria ação desmonta.
 */
export function CloseAttendanceDialog({
  tenantSlug,
  contactId,
  contactName,
  open,
  onOpenChange,
  onClosed,
}: {
  tenantSlug: string;
  contactId: string;
  contactName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClosed: (result: { closed: boolean; clientNotified: boolean }) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      const result = await closeAttendanceAction({ tenantSlug, contactId });
      if (!result.ok) {
        setError(
          result.error.code === "TENANT_SUSPENDED"
            ? "Assinatura suspensa: não é possível encerrar o atendimento até o pagamento."
            : result.error.message || "Não foi possível encerrar agora. Tente de novo.",
        );
        return;
      }
      onOpenChange(false);
      onClosed(result.data);
    } catch {
      setError("Não foi possível encerrar agora. Tente de novo.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader icon={Bot}>
          <DialogTitle>Encerrar e devolver ao bot</DialogTitle>
          <DialogDescription>
            O bot volta a responder {contactName} agora e o atendimento sai da fila. A conversa continua guardada.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="mt-4 rounded-card border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="secondary" icon={X} onClick={() => onOpenChange(false)} disabled={pending}>
            Cancelar
          </Button>
          <Button type="button" icon={Bot} onClick={() => void confirm()} isLoading={pending} loadingText="Encerrando…">
            Encerrar e devolver
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
