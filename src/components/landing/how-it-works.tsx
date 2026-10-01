import { CalendarClock, QrCode, Sparkles } from "lucide-react";
import { SectionHeading } from "./section-heading";

const STEPS = [
  {
    icon: QrCode,
    title: "Conecte o WhatsApp",
    description: "Escaneie um QR Code, como no WhatsApp Web. Seus clientes continuam falando com o número que já conhecem.",
  },
  {
    icon: CalendarClock,
    title: "Cadastre serviços e horários",
    description: "Informe serviços, profissionais e expedientes. Feriados e bloqueios entram na agenda para o bot não oferecer o que você não atende.",
  },
  {
    icon: Sparkles,
    title: "O bot atende por você",
    description: "Ele conversa por menu numerado, marca os horários livres e lembra o cliente. Você acompanha tudo no painel.",
  },
];

export function HowItWorks() {
  return (
    <section id="como-funciona" aria-labelledby="passos-titulo" className="scroll-mt-20 bg-surface py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          id="passos-titulo"
          eyebrow="Como funciona"
          title="Pronto para atender em 3 passos"
          description="Sem instalar nada no computador e sem treinar a equipe por semanas."
        />

        <ol className="relative mt-16 grid gap-10 lg:grid-cols-3 lg:gap-8">
          <span
            aria-hidden="true"
            className="landing-steps-line absolute left-[16.6%] right-[16.6%] top-8 hidden h-0.5 lg:block"
          />
          {STEPS.map((step, index) => (
            <li key={step.title} className="relative flex flex-col items-center text-center">
              <span className="relative flex h-16 w-16 items-center justify-center rounded-hero bg-gradient-to-br from-primary to-primary-strong text-white shadow-lg shadow-primary/30 ring-4 ring-surface">
                <step.icon className="h-7 w-7" aria-hidden="true" />
                <span className="absolute -right-2 -top-2 flex h-7 w-7 items-center justify-center rounded-full bg-text text-xs font-bold text-surface ring-2 ring-surface">
                  <span className="sr-only">Passo </span>
                  {index + 1}
                </span>
              </span>
              <h3 className="mt-6 font-display text-xl font-bold text-text">{step.title}</h3>
              <p className="mt-3 max-w-xs text-base leading-relaxed text-text-secondary">{step.description}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
