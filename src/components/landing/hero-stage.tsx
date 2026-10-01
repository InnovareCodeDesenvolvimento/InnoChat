"use client";

import Image from "next/image";
import { BellRing, Check } from "lucide-react";
import { PhoneDemo, type DemoMode } from "./phone-demo";
import type { DemoMessage } from "./demo-script";

/**
 * Cena do hero: o celular da demo com o Inno ao lado, "apresentando" o aparelho. O Inno é quem
 * responde no WhatsApp, então o balão dele acompanha a conversa: "digitando" enquanto o cabeçalho
 * mostra "digitando...", "Agendado" quando a demo termina. Tudo decorativo (aria-hidden): a conversa
 * já é lida pelo próprio celular.
 *
 * Geometria: `--inno-h` é a altura do Inno por breakpoint; a largura sai da proporção do recorte
 * (334x600). No celular (< md) ele fica em uma linha abaixo do aparelho; de md para cima fica
 * encostado na lateral direita, alinhado ao pé do aparelho, com a mão tocando a moldura.
 */
type Face = "idle" | "working" | "typing" | "done";

function faceOf(mode: DemoMode, typing: boolean): Face {
  if (typing) return "typing";
  if (mode === "done") return "done";
  if (mode === "playing") return "working";
  return "idle";
}

function Bubble({ face }: { face: Face }) {
  return (
    <div
      data-testid="inno-bubble"
      data-face={face}
      className="relative w-max max-w-full rounded-hero bg-surface px-3 py-2 text-xs font-semibold leading-snug text-text shadow-2xl ring-1 ring-border md:absolute md:bottom-full md:right-0 md:mb-2"
    >
      {face === "typing" ? (
        <span className="flex h-4 items-center gap-1" role="presentation">
          <span className="inno-dot h-1.5 w-1.5 rounded-full bg-primary" />
          <span className="inno-dot h-1.5 w-1.5 rounded-full bg-primary [animation-delay:150ms]" />
          <span className="inno-dot h-1.5 w-1.5 rounded-full bg-primary [animation-delay:300ms]" />
        </span>
      ) : face === "done" ? (
        <span className="inline-flex items-center gap-1.5">
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-success text-white">
            <Check className="h-2.5 w-2.5" strokeWidth={3} />
          </span>
          Agendado!
        </span>
      ) : face === "working" ? (
        "Deixa comigo!"
      ) : (
        "Quem responde sou eu!"
      )}
      <span
        className="absolute -right-1 top-3 h-2.5 w-2.5 rotate-45 bg-surface ring-1 ring-border [clip-path:polygon(100%_0,100%_100%,0_100%)] md:bottom-[-5px] md:right-6 md:top-auto md:[clip-path:polygon(100%_0,100%_100%,0_100%)]"
        aria-hidden="true"
      />
    </div>
  );
}

function Inno({ mode, typing }: { mode: DemoMode; typing: boolean }) {
  const face = faceOf(mode, typing);
  return (
    <div
      aria-hidden="true"
      data-testid="inno"
      data-face={face}
      className="inno-companion mt-3 flex items-start justify-end gap-2 md:absolute md:bottom-0 md:left-full md:-ml-1 md:mt-0 md:block md:w-[var(--inno-w)] md:gap-0"
    >
      <Bubble face={face} />
      <Image
        src="/mascote/inno-apresentando.webp"
        alt=""
        width={334}
        height={600}
        unoptimized
        className="inno-img h-[var(--inno-h)] w-auto max-w-none shrink-0 select-none"
      />
    </div>
  );
}

export function HeroStage({ messages, company }: { messages: DemoMessage[]; company: string }) {
  return (
    <div
      className="relative [--inno-h:150px] [--inno-w:calc(var(--inno-h)*0.557)] md:[--inno-h:260px] lg:[--inno-h:220px] xl:[--inno-h:300px]"
    >
      <div className="landing-float relative md:pr-[calc(var(--inno-w)-0.25rem)]">
        <PhoneDemo messages={messages} company={company} companion={(state) => <Inno {...state} />} />
      </div>
      <div
        aria-hidden="true"
        className="absolute bottom-28 right-[calc(50%+(300px+var(--inno-w)-0.25rem)/2+0.75rem)] hidden w-max items-center gap-2.5 rounded-hero bg-surface px-3.5 py-2.5 text-text shadow-2xl ring-1 ring-border 2xl:flex"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-card bg-warning-bg text-warning">
          <BellRing className="h-4 w-4" />
        </span>
        <span className="text-xs font-semibold leading-tight">
          Lembrete enviado
          <span className="block font-normal text-text-secondary">antes do horário</span>
        </span>
      </div>
    </div>
  );
}
