"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Smartphone, Trash2, Unplug, X } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { EmptyState } from "@/components/ui/empty-state";
import { WhatsappEmptyIllustration } from "@/components/ui/empty-illustration";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { ConnectWhatsappDialog } from "@/components/whatsapp/connect-whatsapp-dialog";
import { AddNumberCard } from "@/components/whatsapp/add-number-card";
import { PlanLimitCard } from "@/components/whatsapp/plan-limit-card";
import { WhatsappInstanceCard } from "@/components/whatsapp/whatsapp-instance-card";
import {
  disconnectWhatsappAction,
  refreshConnectionStatusAction,
  removeWhatsappInstanceAction,
  type WhatsappInstanceView,
} from "@/modules/whatsapp/actions";

const WRITE_BLOCKED_HINT = "Assinatura suspensa: só dá para alterar depois do pagamento.";

export type WhatsappPageExtras = {
  maxNumbers: number | null;
  usedNumbers: number;
  welcomePreview: { greeting: string; menu: string };
};

export function WhatsappClient({
  tenantSlug,
  timezone,
  initialInstances,
  isOwner,
  writeBlocked = false,
  extras = null,
}: {
  tenantSlug: string;
  timezone: string;
  initialInstances: WhatsappInstanceView[];
  isOwner: boolean;
  writeBlocked?: boolean;
  extras?: WhatsappPageExtras | null;
}) {
  const { notify } = useToast();
  const [instances, setInstances] = useState<WhatsappInstanceView[]>(initialInstances);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<WhatsappInstanceView | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<WhatsappInstanceView | null>(null);
  const [removeConfirmText, setRemoveConfirmText] = useState("");
  const [isPending, startTransition] = useTransition();
  // Estado do diálogo de conexão mora aqui (não dentro do EmptyState) para o `ConnectWhatsappDialog`
  // ficar SEMPRE montado — se ele morasse dentro do `instances.length === 0 ? <EmptyState .../> :
  // ...`, o `onConnected` do próprio diálogo atualiza a lista e desmonta o EmptyState (e o diálogo
  // aberto dentro dele) no exato instante em que a 1ª conexão termina, sumindo com o passo de
  // sucesso. Ver bug reproduzido em `tests/e2e/whatsapp.spec.ts`.
  const [connectOpen, setConnectOpen] = useState(false);

  function upsertInstance(next: WhatsappInstanceView) {
    setInstances((prev) => {
      const exists = prev.some((i) => i.id === next.id);
      return exists ? prev.map((i) => (i.id === next.id ? next : i)) : [...prev, next];
    });
  }

  function handleRefresh(instance: WhatsappInstanceView) {
    setRefreshingId(instance.id);
    startTransition(async () => {
      const result = await refreshConnectionStatusAction(tenantSlug, instance.id);
      setRefreshingId(null);
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível atualizar", description: result.error.message });
        return;
      }
      upsertInstance({
        ...instance,
        status: result.data.status,
        phoneE164: result.data.phoneE164,
      });
    });
  }

  function handleDisconnect() {
    if (!confirmDisconnect) return;
    const target = confirmDisconnect;
    startTransition(async () => {
      const result = await disconnectWhatsappAction(tenantSlug, target.id);
      setConfirmDisconnect(null);
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível desconectar", description: result.error.message });
        return;
      }
      upsertInstance(result.data);
      notify({ variant: "success", title: "Número desconectado." });
    });
  }

  function handleRemove() {
    if (!confirmRemove) return;
    const target = confirmRemove;
    startTransition(async () => {
      const result = await removeWhatsappInstanceAction(tenantSlug, target.id);
      setConfirmRemove(null);
      setRemoveConfirmText("");
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível remover", description: result.error.message });
        return;
      }
      setInstances((prev) => prev.filter((i) => i.id !== target.id));
      notify({ variant: "success", title: "Número removido." });
    });
  }

  function renderConnectTrigger() {
    return (
      <Button
        onClick={() => setConnectOpen(true)}
        disabled={writeBlocked}
        title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}
      >
        <Smartphone className="h-4 w-4" aria-hidden="true" />
        Conectar número
      </Button>
    );
  }
  const hasInstances = instances.length > 0;
  // O servidor contou `usedNumbers` na carga da página; conexões/remoções feitas aqui mexem na lista local.
  const usedNumbers = extras ? Math.max(0, extras.usedNumbers + (instances.length - initialInstances.length)) : instances.length;
  const limitReached = extras?.maxNumbers != null && usedNumbers >= extras.maxNumbers;

  return (
    <div>
      <PageHeader help="pagina.whatsapp" icon={navIconFor("whatsapp")}
        title="WhatsApp"
        description="Números conectados, QR code e status da conexão."
        action={isOwner && hasInstances && !limitReached ? renderConnectTrigger() : undefined}
      />

      {writeBlocked ? (
        <Alert variant="danger" className="mb-4">
          {WRITE_BLOCKED_HINT}{" "}
          <Link href={`/${tenantSlug}/assinatura`} className="font-medium underline">
            Ver assinatura
          </Link>
        </Alert>
      ) : null}

      {instances.length === 0 ? (
        <EmptyState
          variant="highlight"
          illustration={<WhatsappEmptyIllustration className="h-full w-full" />}
          title="Conecte seu primeiro WhatsApp"
          description="Gere um QR code e escaneie com o celular do número que vai atender seus clientes pelo bot."
          action={isOwner ? renderConnectTrigger() : undefined}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {instances.map((instance) => (
            <WhatsappInstanceCard
              key={instance.id}
              tenantSlug={tenantSlug}
              onStatusChange={upsertInstance}
              instance={instance}
              timezone={timezone}
              isOwner={isOwner}
              writeBlocked={writeBlocked}
              writeBlockedHint={WRITE_BLOCKED_HINT}
              isRefreshing={isPending && refreshingId === instance.id}
              onRefresh={() => handleRefresh(instance)}
              onDisconnect={() => setConfirmDisconnect(instance)}
              onRemove={() => setConfirmRemove(instance)}
              welcomePreview={extras?.welcomePreview ?? null}
            />
          ))}
          {isOwner && limitReached && extras?.maxNumbers != null ? (
            <PlanLimitCard tenantSlug={tenantSlug} used={usedNumbers} max={extras.maxNumbers} />
          ) : isOwner ? (
            <AddNumberCard
              onClick={() => setConnectOpen(true)}
              disabled={writeBlocked}
              disabledHint={WRITE_BLOCKED_HINT}
            />
          ) : null}
        </div>
      )}

      <ConnectWhatsappDialog
        tenantSlug={tenantSlug}
        onConnected={upsertInstance}
        disabled={writeBlocked}
        disabledHint={writeBlocked ? WRITE_BLOCKED_HINT : undefined}
        open={connectOpen}
        onOpenChange={setConnectOpen}
      />

      <Dialog open={!!confirmDisconnect} onOpenChange={(open) => !open && setConfirmDisconnect(null)}>
        <DialogContent>
          <DialogHeader icon={Unplug} tone="danger">
            <DialogTitle>Desconectar número</DialogTitle>
            <DialogDescription>
              &ldquo;{confirmDisconnect?.label}&rdquo; para de atender pelo WhatsApp até ser conectado de novo com um QR
              code novo.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button icon={X} type="button" variant="secondary" onClick={() => setConfirmDisconnect(null)}>
              Cancelar
            </Button>
            <Button icon={Unplug} type="button" variant="danger" onClick={handleDisconnect} isLoading={isPending} loadingText="Desconectando…">
              Desconectar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!confirmRemove}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmRemove(null);
            setRemoveConfirmText("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader icon={Trash2} tone="danger">
            <DialogTitle>Remover número</DialogTitle>
            <DialogDescription>
              Isso remove &ldquo;{confirmRemove?.label}&rdquo; de vez, inclusive da Evolution. Para conectar este número
              de novo depois, será preciso escanear um QR code novo. Digite <strong>{confirmRemove?.label}</strong> para
              confirmar.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4">
            <Field label="Rótulo do número" htmlFor="confirm-remove-label">
              {(fieldProps) => (
                <Input {...fieldProps} value={removeConfirmText} onChange={(e) => setRemoveConfirmText(e.target.value)} />
              )}
            </Field>
          </div>
          <DialogFooter>
            <Button icon={X} type="button" variant="secondary" onClick={() => setConfirmRemove(null)}>
              Cancelar
            </Button>
            <Button
              icon={Trash2}
              type="button"
              variant="danger"
              onClick={handleRemove}
              isLoading={isPending}
              disabled={removeConfirmText !== confirmRemove?.label}
             loadingText="Removendo…">
              Remover para sempre
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
