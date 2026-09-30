"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { BellRing, Info, MessageSquareText, Save } from "lucide-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { updateReminderSettingsAction } from "@/modules/reminders/actions";

export const REMINDER_HOURS_MIN = 2;
export const REMINDER_HOURS_MAX = 48;

/**
 * Lembrete de véspera por WhatsApp. O OWNER edita; o STAFF só vê (os controles ficam
 * desabilitados com a explicação ao lado — a regra de verdade é do servidor). Assinatura
 * suspensa também bloqueia a edição, igual às outras telas de escrita.
 */
export function LembreteCard({
  tenantSlug,
  initial,
  isOwner,
  writeBlocked,
}: {
  tenantSlug: string;
  initial: { enabled: boolean; hoursBefore: number };
  isOwner: boolean;
  writeBlocked: boolean;
}) {
  const { notify } = useToast();
  const [saved, setSaved] = useState(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [hours, setHours] = useState(String(initial.hoursBefore));
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const canEdit = isOwner && !writeBlocked;
  const parsedHours = Number(hours);
  const dirty = enabled !== saved.enabled || parsedHours !== saved.hoursBefore;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!Number.isInteger(parsedHours) || parsedHours < REMINDER_HOURS_MIN || parsedHours > REMINDER_HOURS_MAX) {
      setError(`Informe um número inteiro de horas entre ${REMINDER_HOURS_MIN} e ${REMINDER_HOURS_MAX}.`);
      return;
    }
    startTransition(async () => {
      const result = await updateReminderSettingsAction({ tenantSlug, enabled, hoursBefore: parsedHours });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setSaved({ enabled, hoursBefore: parsedHours });
      notify({ variant: "success", title: enabled ? "Lembrete automático ligado." : "Lembrete automático desligado." });
    });
  }

  return (
    <Card className="rounded-hero" data-testid="lembrete-card">
      <CardHeader help="config.lembrete">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-card bg-primary/10 text-primary">
            <BellRing className="h-[18px] w-[18px]" />
          </span>
          <CardTitle>Lembrete automático para clientes</CardTitle>
          <Badge variant={saved.enabled ? "success" : "neutral"}>{saved.enabled ? "Ligado" : "Desligado"}</Badge>
        </div>
        <CardDescription>
          O bot avisa o cliente no WhatsApp antes do horário marcado — menos faltas sem você precisar ligar.
        </CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit} noValidate>
        <CardContent className="flex flex-col gap-5">
          {/* Chave colada ao rótulo (antes ficava na borda direita do card largo e o dono não a achava). */}
          <div className="flex items-start gap-3">
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={!canEdit || isPending}
              aria-labelledby="reminder-enabled-label"
              aria-describedby="reminder-enabled-hint"
              className="mt-0.5"
            />
            <div className="min-w-0">
              <p id="reminder-enabled-label" className="text-sm font-semibold text-text">
                Enviar lembrete automático
              </p>
              <p id="reminder-enabled-hint" className="text-xs text-text-secondary">
                {enabled
                  ? "Os clientes com horário marcado recebem o aviso."
                  : "Desligado: nenhum lembrete é enviado. Ligue a chave e clique em Salvar."}
              </p>
            </div>
          </div>

          <div className="max-w-xs">
            <Field
              label="Enviar com quantas horas de antecedência"
              htmlFor="reminder-hours"
              required
              error={error}
              hint={!error ? `De ${REMINDER_HOURS_MIN} a ${REMINDER_HOURS_MAX} horas. O padrão é 24.` : undefined}
            >
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  type="number"
                  inputMode="numeric"
                  name="hoursBefore"
                  min={REMINDER_HOURS_MIN}
                  max={REMINDER_HOURS_MAX}
                  step={1}
                  value={hours}
                  onChange={(e) => setHours(e.target.value)}
                  disabled={!canEdit || isPending}
                  invalid={!!error}
                />
              )}
            </Field>
          </div>

          <div className="flex items-start gap-2.5 rounded-card border border-border bg-bg p-3 text-sm text-text-secondary">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <p>
              Enviado pelo WhatsApp entre 8h e 21h; o cliente pode responder <strong className="font-semibold text-text">menu</strong>{" "}
              para remarcar ou cancelar.
            </p>
          </div>

          {!isOwner ? (
            <p className="text-sm text-text-secondary">Só o dono da empresa pode alterar o lembrete.</p>
          ) : writeBlocked ? (
            <p className="text-sm text-text-secondary">Assinatura suspensa — edição bloqueada até o pagamento.</p>
          ) : null}
        </CardContent>
        <CardFooter className="flex-wrap justify-between">
          <Button asChild variant="secondary">
            <Link href={`/${tenantSlug}/mensagens-bot#lembretes`}>
              <MessageSquareText className="h-4 w-4" aria-hidden="true" />
              Editar o texto do lembrete
            </Link>
          </Button>
          {canEdit ? (
            <Button type="submit" icon={Save} isLoading={isPending} loadingText="Salvando…" disabled={!dirty}>
              Salvar
            </Button>
          ) : null}
        </CardFooter>
      </form>
    </Card>
  );
}
