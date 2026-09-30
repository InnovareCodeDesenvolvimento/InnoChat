"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/cn";
import { APP_VERSION, BUILD_DATE, DESENVOLVEDORA, DESENVOLVEDORA_URL, VERSAO_EXIBIDA } from "@/lib/app-info";

/**
 * Selo da desenvolvedora: FLUTUANTE no canto inferior direito dos painéis (tenant e admin), sempre
 * visível — decisão do dono (2026-09-30). Para não atrapalhar o uso (a versão grande cobria Salvar,
 * Avançar e o ⓘ do Início), em repouso é uma pílula COMPACTA (logo + versão, ~100px); "Desenvolvido
 * por InnovareCode" só abre no hover/foco. O `main` dos shells reserva `pb-16` para o fim da página
 * rolar acima dele. Superfície translúcida em repouso e opaca no hover; texto sempre com contraste AA.
 *
 * Se, ao rolar, um botão/campo/link passa por BAIXO dele, o selo some (fade) até o caminho ficar
 * livre — nunca fica por cima de algo clicável.
 *
 * Camadas: z-40, abaixo dos diálogos/gaveta (z-50), do tour (z-70/80) e dos toasts (z-100, que sobem
 * para não cobri-lo — ver `ui/toast.tsx`). Alvo de toque de 44px.
 */
const INTERACTIVE = "a,button,input,select,textarea,[role=switch],[role=tab],[role=button]";

/**
 * Algum controle (botão, campo, link) está debaixo do selo a ponto de atrapalhar? Conta quando o
 * selo cobre 25% ou mais da área do controle — uma linha de lista de largura inteira que passa por
 * baixo continua clicável no resto dela e não esconde o selo; um "Salvar" coberto, sim. Inclui
 * controles desabilitados (sem pointer-events), que ficam clicáveis assim que habilitam.
 */
function coversInteractive(badge: HTMLElement): boolean {
  const b = badge.getBoundingClientRect();
  for (const el of document.querySelectorAll<HTMLElement>(INTERACTIVE)) {
    if (badge.contains(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.bottom < b.top || r.top > b.bottom || r.right < b.left || r.left > b.right) continue;
    const w = Math.min(r.right, b.right) - Math.max(r.left, b.left);
    const h = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
    if (w > 0 && h > 0 && (w * h) / (r.width * r.height) >= 0.25) return true;
  }
  return false;
}

export function InnovareCodeBadge({ className }: { className?: string }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const [yielding, setYielding] = useState(false);

  useEffect(() => {
    const badge = ref.current;
    if (!badge) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      setYielding(coversInteractive(badge));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    // Conteúdo que muda sem rolar (abas, listas carregando) também pode passar por baixo.
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
    };
  }, []);

  return (
    <a
      ref={ref}
      data-yielding={yielding ? "true" : undefined}
      href={DESENVOLVEDORA_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Desenvolvido por ${DESENVOLVEDORA}, versão ${APP_VERSION}`}
      title={`Desenvolvido por ${DESENVOLVEDORA} · ${VERSAO_EXIBIDA} (build ${BUILD_DATE})`}
      className={cn(
        "group fixed bottom-3 right-3 z-40 flex min-h-11 items-center gap-1.5 rounded-full bg-surface/75 py-1 pl-2 pr-1.5",
        "shadow-card ring-1 ring-border backdrop-blur-md transition-all",
        "hover:bg-surface hover:shadow-card-hover focus-visible:bg-surface",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        "motion-reduce:transition-none",
        yielding && "pointer-events-none opacity-0",
        className,
      )}
    >
      {/* <img> simples: PNG estático pequeno, sem otimização de imagem (mesma escolha do AuthShell). */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/innovarecode.png"
        alt=""
        aria-hidden="true"
        width={49}
        height={32}
        decoding="async"
        className="h-5 w-auto"
      />
      {/* Fechado em repouso; abre no hover/foco (o nome completo também está no aria-label e no title). */}
      <span
        aria-hidden="true"
        className="flex max-w-0 flex-col overflow-hidden leading-none opacity-0 transition-all duration-200 group-hover:max-w-40 group-hover:opacity-100 group-focus-visible:max-w-40 group-focus-visible:opacity-100 motion-reduce:transition-none"
      >
        <span className="whitespace-nowrap text-[9px] font-bold uppercase tracking-widest text-text-secondary">Desenvolvido por</span>
        <span className="mt-0.5 whitespace-nowrap text-[11px] font-black tracking-tight text-text">{DESENVOLVEDORA}</span>
      </span>
      <span className="rounded-full bg-bg px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-text-secondary ring-1 ring-border">
        {VERSAO_EXIBIDA}
      </span>
    </a>
  );
}
