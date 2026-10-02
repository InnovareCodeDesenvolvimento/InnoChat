"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { adminResetTwoFactorAction } from "@/modules/two-factor/actions";
import type { TwoFactorMemberRow } from "@/modules/two-factor/service";

/**
 * Lista de pessoas com o estado da verificação em 2 etapas e o botão "Redefinir" (para quem perdeu
 * o celular e os códigos). Pede confirmação: a pessoa é desconectada e precisa ativar de novo.
 */
export function TwoFactorResetList({ rows, emptyText }: { rows: TwoFactorMemberRow[]; emptyText: string }) {
  const router = useRouter();
  const { notify } = useToast();
  const [target, setTarget] = useState<TwoFactorMemberRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function confirmReset() {
    if (!target) return;
    setError(null);
    startTransition(async () => {
      const result = await adminResetTwoFactorAction({ userId: target.userId });
      if (!result.ok) return setError(result.error.message);
      notify({ variant: "success", title: "Verificação em 2 etapas redefinida." });
      setTarget(null);
      router.refresh();
    });
  }

  if (rows.length === 0) return <p className="p-5 text-sm text-text-secondary">{emptyText}</p>;

  return (
    <>
      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <li key={row.userId} className="flex flex-wrap items-center justify-between gap-3 p-4 sm:px-5">
            <div className="min-w-0">
              <p className="break-all text-sm font-medium text-text">{row.name ? `${row.name} (${row.email})` : row.email}</p>
              <p className="mt-0.5 text-xs text-text-secondary">{row.roleLabel}</p>
            </div>
            <div className="flex items-center gap-3">
              {row.enabled ? <Badge variant="success">2 etapas ativa</Badge> : <Badge variant="neutral">Sem 2 etapas</Badge>}
              {row.enabled ? (
                <Button variant="outline" size="sm" onClick={() => { setError(null); setTarget(row); }}>
                  Redefinir
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <Dialog open={target !== null} onOpenChange={(open) => { if (!open) setTarget(null); }}>
        <DialogContent>
          <DialogHeader icon={ShieldAlert} tone="warning">
            <DialogTitle>Redefinir a verificação em 2 etapas?</DialogTitle>
            <DialogDescription>
              {target ? `${target.email} vai ser desconectado e terá que cadastrar a verificação de novo no próximo acesso.` : null}
            </DialogDescription>
          </DialogHeader>
          {error ? <Alert variant="danger" className="mt-4">{error}</Alert> : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTarget(null)}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={confirmReset} isLoading={isPending} loadingText="Redefinindo…">
              Redefinir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
