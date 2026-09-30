"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Headset, Info, Save } from "lucide-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/components/lib/cn";
import { updateBotRulesAction } from "@/modules/tenant/actions";

export const MAX_FUTURE_MIN = 0;
export const MAX_FUTURE_MAX = 20;
export const RESUME_MIN = 30;
export const RESUME_MAX = 1440;

/** Espelho do `BotRules` do contrato (docs/bot-v2-plano.md §3.5). */
export type BotRulesValue = {
  maxFutureAppointmentsPerContact: number;
  slotGranularityMin: 15 | 30;
  handoffResumeMinutes: number;
  humanPauseMin: number;
  /** Avisa o cliente no WhatsApp quando a equipe agenda, remarca ou cancela pelo painel. */
  notifyClientOnStaffChanges: boolean;
};

/** Opções prontas para o tempo sem resposta (o servidor aceita 30..1440, múltiplo de 15). */
const RESUME_PRESETS = [30, 60, 90, 120, 180, 240, 360, 720, 1440];

export function formatMinutes(total: number): string {
  if (total < 60) return `${total} minutos`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (m === 0) return h === 1 ? "1 hora" : `${h} horas`;
  return `${h}h${String(m).padStart(2, "0")}`;
}

const GRANULARITY_OPTIONS: { value: 15 | 30; title: string; example: string }[] = [
  { value: 30, title: "A cada 30 minutos", example: "09:00, 09:30, 10:00…" },
  { value: 15, title: "A cada 15 minutos", example: "09:00, 09:15, 09:30…" },
];

type FieldErrors = Partial<Record<"max" | "resume", string>>;

/**
 * Regras do atendimento pelo WhatsApp (bot v2). O OWNER edita; o STAFF só vê — controles
 * desabilitados com a explicação embaixo (a regra de verdade é do servidor). Assinatura suspensa
 * também bloqueia, igual às outras telas de escrita. Mesmo padrão visual do `lembrete-card`.
 */
export function AtendimentoCard({
  tenantSlug,
  initial,
  isOwner,
  writeBlocked,
}: {
  tenantSlug: string;
  initial: BotRulesValue;
  isOwner: boolean;
  writeBlocked: boolean;
}) {
  const { notify } = useToast();
  const [saved, setSaved] = useState(initial);
  const [maxFuture, setMaxFuture] = useState(String(initial.maxFutureAppointmentsPerContact));
  const [granularity, setGranularity] = useState<15 | 30>(initial.slotGranularityMin);
  const [resume, setResume] = useState(String(initial.handoffResumeMinutes));
  const [notifyClient, setNotifyClient] = useState(initial.notifyClientOnStaffChanges);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const canEdit = isOwner && !writeBlocked;
  const parsedMax = maxFuture.trim() === "" ? NaN : Number(maxFuture);
  const parsedResume = Number(resume);
  const dirty =
    parsedMax !== saved.maxFutureAppointmentsPerContact ||
    granularity !== saved.slotGranularityMin ||
    parsedResume !== saved.handoffResumeMinutes ||
    notifyClient !== saved.notifyClientOnStaffChanges;

  const resumeOptions = RESUME_PRESETS.includes(parsedResume) ? RESUME_PRESETS : [...RESUME_PRESETS, parsedResume].sort((a, b) => a - b);

  function validateMax(value: number): string | undefined {
    if (!Number.isInteger(value) || value < MAX_FUTURE_MIN || value > MAX_FUTURE_MAX) {
      return `Informe um número inteiro de ${MAX_FUTURE_MIN} a ${MAX_FUTURE_MAX}.`;
    }
    return undefined;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const next: FieldErrors = {};
    const maxError = validateMax(parsedMax);
    if (maxError) next.max = maxError;
    if (!Number.isInteger(parsedResume) || parsedResume < RESUME_MIN || parsedResume > RESUME_MAX || parsedResume % 15 !== 0) {
      next.resume = "Escolha um tempo entre 30 minutos e 24 horas.";
    }
    setErrors(next);
    if (next.max || next.resume) return;

    startTransition(async () => {
      const result = await updateBotRulesAction(tenantSlug, {
        maxFutureAppointmentsPerContact: parsedMax,
        slotGranularityMin: granularity,
        handoffResumeMinutes: parsedResume,
        notifyClientOnStaffChanges: notifyClient,
      });
      if (!result.ok) {
        const field = (result.error.details as { field?: string } | undefined)?.field;
        if (field === "maxFutureAppointmentsPerContact") setErrors({ max: result.error.message });
        else if (field === "handoffResumeMinutes") setErrors({ resume: result.error.message });
        else setFormError(result.error.message);
        return;
      }
      setSaved(result.data);
      setMaxFuture(String(result.data.maxFutureAppointmentsPerContact));
      setGranularity(result.data.slotGranularityMin);
      setResume(String(result.data.handoffResumeMinutes));
      setNotifyClient(result.data.notifyClientOnStaffChanges);
      notify({ variant: "success", title: "Regras do atendimento salvas." });
    });
  }

  return (
    <Card className="rounded-hero" data-testid="atendimento-card">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-card bg-primary/10 text-primary">
            <Headset className="h-[18px] w-[18px]" />
          </span>
          <CardTitle>Atendimento pelo WhatsApp</CardTitle>
        </div>
        <CardDescription>
          Regras que o bot segue ao marcar horários e ao passar a conversa para a sua equipe.
        </CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit} noValidate>
        <CardContent className="flex flex-col gap-6">
          <div className="max-w-xs">
            <Field
              label="Agendamentos futuros por cliente"
              htmlFor="bot-max-future"
              required
              error={errors.max}
              hint={!errors.max ? "Quantos horários um mesmo cliente pode ter marcados ao mesmo tempo. 0 = sem limite." : undefined}
            >
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  type="number"
                  inputMode="numeric"
                  name="maxFutureAppointmentsPerContact"
                  min={MAX_FUTURE_MIN}
                  max={MAX_FUTURE_MAX}
                  step={1}
                  value={maxFuture}
                  onChange={(e) => {
                    setMaxFuture(e.target.value);
                    if (errors.max) setErrors((prev) => ({ ...prev, max: undefined }));
                  }}
                  onBlur={() => {
                    const msg = validateMax(parsedMax);
                    setErrors((prev) => ({ ...prev, max: msg }));
                  }}
                  disabled={!canEdit || isPending}
                  invalid={!!errors.max}
                />
              )}
            </Field>
          </div>

          <fieldset className="min-w-0" disabled={!canEdit || isPending}>
            <legend className="mb-1.5 text-sm font-medium text-text">Grade de horários</legend>
            <div role="radiogroup" aria-describedby="bot-granularity-hint" className="grid gap-3 sm:grid-cols-2">
              {GRANULARITY_OPTIONS.map((opt) => {
                const checked = granularity === opt.value;
                return (
                  <label
                    key={opt.value}
                    className={cn(
                      "flex min-h-[44px] cursor-pointer items-start gap-3 rounded-card border p-3 transition-colors duration-150 motion-reduce:transition-none",
                      "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary",
                      "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60",
                      checked ? "border-primary bg-primary/5" : "border-border bg-surface hover:bg-bg",
                    )}
                  >
                    <input
                      type="radio"
                      name="slotGranularityMin"
                      value={opt.value}
                      checked={checked}
                      onChange={() => setGranularity(opt.value)}
                      className="sr-only"
                    />
                    <span
                      aria-hidden="true"
                      className={cn(
                        "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                        checked ? "border-primary" : "border-border",
                      )}
                    >
                      {checked ? <span className="h-2 w-2 rounded-full bg-primary" /> : null}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-text">{opt.title}</span>
                      <span className="block text-xs text-text-secondary">Ex.: {opt.example}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <p id="bot-granularity-hint" className="mt-1.5 text-xs text-text-secondary">
              É o intervalo entre os horários que o bot oferece ao cliente.
            </p>
          </fieldset>

          <div className="max-w-xs">
            <Field
              label="Bot volta a responder depois de"
              htmlFor="bot-resume"
              required
              error={errors.resume}
              hint={!errors.resume ? "Tempo sem resposta da equipe depois que o cliente pede um atendente." : undefined}
            >
              {(fieldProps) => (
                <Select
                  {...fieldProps}
                  name="handoffResumeMinutes"
                  value={resume}
                  onChange={(e) => {
                    setResume(e.target.value);
                    if (errors.resume) setErrors((prev) => ({ ...prev, resume: undefined }));
                  }}
                  disabled={!canEdit || isPending}
                  invalid={!!errors.resume}
                >
                  {resumeOptions.map((m) => (
                    <option key={m} value={m}>
                      {formatMinutes(m)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-card border border-border p-3">
            <div className="min-w-0">
              <p id="bot-notify-client-label" className="text-sm font-semibold text-text">
                Avisar o cliente no WhatsApp quando a equipe agendar, remarcar ou cancelar
              </p>
              <p id="bot-notify-client-hint" className="mt-0.5 text-xs text-text-secondary">
                {notifyClient ? "O cliente recebe uma mensagem a cada mudança feita pelo painel." : "O cliente não é avisado das mudanças feitas pelo painel."}{" "}
                O texto de cada aviso fica em{" "}
                <Link href={`/${tenantSlug}/mensagens-bot`} className="font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
                  Mensagens do bot
                </Link>
                .
              </p>
            </div>
            <Switch
              checked={notifyClient}
              onCheckedChange={setNotifyClient}
              disabled={!canEdit || isPending}
              aria-labelledby="bot-notify-client-label"
              aria-describedby="bot-notify-client-hint"
            />
          </div>

          <div className="flex items-start gap-2.5 rounded-card border border-border bg-bg p-3 text-sm text-text-secondary">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <p>
              Se a sua equipe responder o cliente, pelo painel ou pelo celular, o bot fica em silêncio pelo mesmo tempo da
              retomada acima (<strong className="font-semibold text-text">{formatMinutes(saved.handoffResumeMinutes)}</strong>) a cada
              resposta. O cliente pode digitar <strong className="font-semibold text-text">menu</strong> a qualquer momento para voltar.
            </p>
          </div>

          {formError ? (
            <p role="alert" className="text-sm text-danger">
              {formError}
            </p>
          ) : null}
          {!isOwner ? (
            <p className="text-sm text-text-secondary">Só o dono da empresa pode alterar estas regras.</p>
          ) : writeBlocked ? (
            <p className="text-sm text-text-secondary">Assinatura suspensa — edição bloqueada até o pagamento.</p>
          ) : null}
        </CardContent>
        {canEdit ? (
          <CardFooter className="justify-end">
            <Button type="submit" icon={Save} isLoading={isPending} loadingText="Salvando…" disabled={!dirty}>
              Salvar
            </Button>
          </CardFooter>
        ) : null}
      </form>
    </Card>
  );
}
