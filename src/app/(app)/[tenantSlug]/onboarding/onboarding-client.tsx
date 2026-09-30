"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { ArrowLeft, ArrowRight, Check, MessageCircle, Plus, Rocket, Scissors, UserRound } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/components/lib/cn";
import { ConnectWhatsappDialog } from "@/components/whatsapp/connect-whatsapp-dialog";
import {
  createProfessionalAction,
  createServiceAction,
  setProfessionalWorkingHoursAction,
} from "@/modules/agenda/catalog-actions";

export type OnboardingService = { id: string; name: string; durationMin: number };
export type OnboardingProfessional = {
  id: string;
  name: string;
  workingHours: { id: string; weekday: number; startTime: string; endTime: string }[];
};

const DEFAULT_WORKING_HOURS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: "09:00", endTime: "18:00" }));

const STEPS = [
  { label: "Serviços", icon: Scissors },
  { label: "Profissionais", icon: UserRound },
  { label: "WhatsApp", icon: MessageCircle },
  { label: "Testar", icon: Rocket },
];

function StepIndicator({ current }: { current: number }) {
  return (
    <ol className="mb-6 flex flex-wrap items-center gap-2" aria-label="Etapas da configuração">
      {STEPS.map((step, index) => {
        const stepNumber = index + 1;
        const active = stepNumber === current;
        const done = stepNumber < current;
        return (
          <li key={step.label} className="flex items-center gap-2">
            <span
              aria-current={active ? "step" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition-[transform,box-shadow] duration-200 motion-reduce:transition-none",
                active && "border-primary bg-primary/10 text-primary shadow-card-hover",
                done && "border-success/30 bg-success-bg text-success",
                !active && !done && "border-border text-text-secondary",
              )}
            >
              {done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <step.icon className="h-3.5 w-3.5" aria-hidden="true" />}
              {stepNumber}. {step.label}
            </span>
            {index < STEPS.length - 1 ? (
              <span className={cn("h-px w-4 sm:w-6", done ? "bg-success/40" : "bg-border")} aria-hidden="true" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export function OnboardingClient({
  tenantSlug,
  initialServices,
  initialProfessionals,
  initialWhatsappConnected = false,
}: {
  tenantSlug: string;
  initialServices: OnboardingService[];
  initialProfessionals: OnboardingProfessional[];
  initialWhatsappConnected?: boolean;
}) {
  const { notify } = useToast();
  const [services, setServices] = useState<OnboardingService[]>(initialServices);
  const [professionals, setProfessionals] = useState<OnboardingProfessional[]>(initialProfessionals);
  const [whatsappConnected, setWhatsappConnected] = useState(initialWhatsappConnected);
  const [step, setStep] = useState(1);
  const [isPending, startTransition] = useTransition();

  const [serviceName, setServiceName] = useState("");
  const [serviceDuration, setServiceDuration] = useState("30");
  const [serviceError, setServiceError] = useState<string | null>(null);

  const [professionalName, setProfessionalName] = useState("");
  const [professionalError, setProfessionalError] = useState<string | null>(null);

  function handleAddService(e: React.FormEvent) {
    e.preventDefault();
    setServiceError(null);
    if (serviceName.trim().length < 1) {
      setServiceError("Informe o nome do serviço.");
      return;
    }
    startTransition(async () => {
      const result = await createServiceAction(tenantSlug, {
        name: serviceName.trim(),
        durationMin: Number(serviceDuration) || 30,
      });
      if (!result.ok) {
        setServiceError(result.error.message);
        return;
      }
      const saved = result.data as OnboardingService;
      setServices((prev) => [...prev, saved]);
      setServiceName("");
      setServiceDuration("30");
      notify({ variant: "success", title: "Serviço criado." });
    });
  }

  function handleAddProfessional(e: React.FormEvent) {
    e.preventDefault();
    setProfessionalError(null);
    if (professionalName.trim().length < 1) {
      setProfessionalError("Informe o nome do profissional.");
      return;
    }
    startTransition(async () => {
      const createResult = await createProfessionalAction(tenantSlug, { name: professionalName.trim() });
      if (!createResult.ok) {
        setProfessionalError(createResult.error.message);
        return;
      }
      const created = createResult.data as { id: string; name: string };
      const hoursResult = await setProfessionalWorkingHoursAction(tenantSlug, created.id, { hours: DEFAULT_WORKING_HOURS });
      const workingHours = hoursResult.ok ? (hoursResult.data as OnboardingProfessional["workingHours"]) : [];
      setProfessionals((prev) => [...prev, { id: created.id, name: created.name, workingHours }]);
      setProfessionalName("");
      notify({
        variant: "success",
        title: "Profissional criado.",
        description: "Expediente padrão (seg. a sex., 9h às 18h) já aplicado — ajuste depois em Profissionais, se precisar.",
      });
    });
  }

  const hasService = services.length > 0;
  const hasProfessionalWithHours = professionals.some((p) => p.workingHours.length > 0);

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader help="pagina.onboarding" icon={navIconFor("onboarding")} title="Primeiros passos" description="Configure sua empresa para começar a agendar pelo painel." />

      <StepIndicator current={step} />

      {step === 1 ? (
        <Card className="rounded-hero">
          <CardHeader>
            <CardTitle>Cadastre seus serviços</CardTitle>
            <CardDescription>O que sua empresa oferece — corte de cabelo, consulta, sessão, etc.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {services.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {services.map((service) => (
                  <li key={service.id} className="flex items-center justify-between rounded-card border border-border p-3">
                    <span className="text-sm text-text">{service.name}</span>
                    <Badge variant="neutral">{service.durationMin} min</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-text-secondary">Nenhum serviço ainda — adicione o primeiro abaixo.</p>
            )}

            <form onSubmit={handleAddService} className="flex flex-col gap-4 border-t border-border pt-4 sm:flex-row sm:items-end">
              {serviceError ? (
                <Alert variant="danger" className="sm:w-full">
                  {serviceError}
                </Alert>
              ) : null}
              <div className="flex-1">
                <Field label="Nome do serviço" required>
                  {(fieldProps) => (
                    <Input {...fieldProps} value={serviceName} onChange={(e) => setServiceName(e.target.value)} maxLength={120} />
                  )}
                </Field>
              </div>
              <div className="w-32">
                <Field label="Duração (min)" required>
                  {(fieldProps) => (
                    <Input
                      {...fieldProps}
                      type="number"
                      min={5}
                      max={1440}
                      value={serviceDuration}
                      onChange={(e) => setServiceDuration(e.target.value)}
                    />
                  )}
                </Field>
              </div>
              <Button icon={Plus} type="submit" isLoading={isPending} loadingText="Adicionando…">
                Adicionar
              </Button>
            </form>
          </CardContent>
          <CardFooter className="justify-end">
            <Button icon={hasService ? ArrowRight : undefined} onClick={() => setStep(2)} disabled={!hasService}>
              {hasService ? "Avançar" : "Adicione ao menos 1 serviço"}
            </Button>
          </CardFooter>
        </Card>
      ) : null}

      {step === 2 ? (
        <Card className="rounded-hero">
          <CardHeader>
            <CardTitle>Profissionais e expediente</CardTitle>
            <CardDescription>Quem atende. Já deixamos um expediente padrão (seg. a sex., 9h às 18h) — ajuste depois.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {professionals.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {professionals.map((professional) => (
                  <li key={professional.id} className="flex items-center justify-between rounded-card border border-border p-3">
                    <span className="text-sm text-text">{professional.name}</span>
                    <Badge variant={professional.workingHours.length > 0 ? "success" : "warning"}>
                      {professional.workingHours.length > 0 ? "Com expediente" : "Sem expediente"}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-text-secondary">Nenhum profissional ainda — adicione o primeiro abaixo.</p>
            )}

            <form onSubmit={handleAddProfessional} className="flex flex-col gap-4 border-t border-border pt-4 sm:flex-row sm:items-end">
              {professionalError ? (
                <Alert variant="danger" className="sm:w-full">
                  {professionalError}
                </Alert>
              ) : null}
              <div className="flex-1">
                <Field label="Nome do profissional" required>
                  {(fieldProps) => (
                    <Input {...fieldProps} value={professionalName} onChange={(e) => setProfessionalName(e.target.value)} maxLength={120} />
                  )}
                </Field>
              </div>
              <Button icon={Plus} type="submit" isLoading={isPending} loadingText="Adicionando…">
                Adicionar
              </Button>
            </form>
          </CardContent>
          <CardFooter className="justify-between">
            <Button icon={ArrowLeft} variant="ghost" onClick={() => setStep(1)}>
              Voltar
            </Button>
            <Button icon={hasProfessionalWithHours ? ArrowRight : undefined} onClick={() => setStep(3)} disabled={!hasProfessionalWithHours}>
              {hasProfessionalWithHours ? "Avançar" : "Adicione ao menos 1 profissional"}
            </Button>
          </CardFooter>
        </Card>
      ) : null}

      {step === 3 ? (
        <Card className="rounded-hero">
          <CardHeader>
            <CardTitle>Conectar WhatsApp</CardTitle>
            <CardDescription>O número que o bot vai usar para atender seus clientes.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {whatsappConnected ? (
              <Alert variant="success">Número conectado. Você pode conectar outro a qualquer momento por aqui ou em WhatsApp, na barra lateral.</Alert>
            ) : (
              <Alert variant="info">
                Você já pode continuar configurando e usar a agenda manualmente sem conectar agora — nada aqui trava
                seu uso do painel.
              </Alert>
            )}
            <div>
              <ConnectWhatsappDialog tenantSlug={tenantSlug} onConnected={() => setWhatsappConnected(true)} />
            </div>
          </CardContent>
          <CardFooter className="justify-between">
            <Button icon={ArrowLeft} variant="ghost" onClick={() => setStep(2)}>
              Voltar
            </Button>
            <Button icon={ArrowRight} onClick={() => setStep(4)}>Avançar</Button>
          </CardFooter>
        </Card>
      ) : null}

      {step === 4 ? (
        <Card className="rounded-hero">
          <CardHeader>
            <CardTitle>Tudo pronto para testar</CardTitle>
            <CardDescription>Você já pode criar um agendamento manual para ver como funciona.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm text-text-secondary">
            <p>✓ {services.length} serviço(s) cadastrado(s)</p>
            <p>✓ {professionals.length} profissional(is) cadastrado(s)</p>
          </CardContent>
          <CardFooter className="justify-between">
            <Button icon={ArrowLeft} variant="ghost" onClick={() => setStep(3)}>
              Voltar
            </Button>
            <Button asChild>
              <Link href={`/${tenantSlug}/agenda`}>Ir para a agenda</Link>
            </Button>
          </CardFooter>
        </Card>
      ) : null}
    </div>
  );
}
