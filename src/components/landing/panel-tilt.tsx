"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/components/lib/cn";

/**
 * Telas do painel "inclinadas em perspectiva" que se endireitam conforme a rolagem (como nos sites
 * da Apple e da Stripe). Sem biblioteca:
 *
 * - Navegadores com `animation-timeline: view()` fazem tudo em CSS (globals.css, `.pt-body`): zero
 *   JavaScript por quadro, e a animação roda no compositor.
 * - Os demais (Safari/Firefox antigos) usam o fallback abaixo: um IntersectionObserver liga um
 *   ouvinte de rolagem (rAF) só enquanto a vitrine está perto da tela e escreve `--pt-p` (0 a 1) no
 *   elemento; o mesmo CSS lê essa variável.
 * - Com `prefers-reduced-motion`, ou sem JS e sem suporte nativo, a tela fica reta.
 *
 * `from` = inclinação inicial por breakpoint (variáveis CSS `--pt-x`/`--pt-y`, em graus).
 */
const NATIVE = "(animation-timeline: view())";

export function PanelTilt({
  children,
  className,
  tiltX = 14,
  tiltY = -8,
  testId,
}: {
  children: ReactNode;
  className?: string;
  /** Inclinação inicial (graus) em torno do eixo X (para trás) e Y (para o lado) em telas largas. */
  tiltX?: number;
  tiltY?: number;
  testId?: string;
}) {
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof CSS !== "undefined" && CSS.supports?.(NATIVE)) return;

    // Fallback por rolagem: progresso 0 (entrando) a 1 (inteira na janela).
    stage.dataset.ptJs = "true";
    stage.style.setProperty("--pt-p", "0");
    let frame = 0;
    const update = () => {
      frame = 0;
      const rect = stage.getBoundingClientRect();
      const vh = window.innerHeight;
      // Mesma janela do CSS nativo (`animation-range: entry 10% cover 45%`): "cover" vai da borda de
      // cima entrando até a de baixo saindo; "entry 10%" fica a 10% da altura da tela de entrada.
      const cover = (vh - rect.top) / (vh + rect.height);
      const start = (0.1 * rect.height) / (vh + rect.height);
      const p = Math.min(1, Math.max(0, (cover - start) / (0.45 - start)));
      // Mesma curva de desaceleração do CSS.
      stage.style.setProperty("--pt-p", (1 - (1 - p) ** 2.2).toFixed(3));
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        const near = entries.some((e) => e.isIntersecting);
        window.removeEventListener("scroll", schedule);
        if (near) {
          window.addEventListener("scroll", schedule, { passive: true });
          schedule();
        }
      },
      { rootMargin: "20% 0px 20% 0px" },
    );
    observer.observe(stage);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", schedule);
      delete stage.dataset.ptJs;
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  const vars = { "--pt-x": `${tiltX}deg`, "--pt-y": `${tiltY}deg` } as CSSProperties;

  return (
    <div ref={stageRef} data-testid={testId} className={cn("pt-stage relative", className)} style={vars}>
      <div aria-hidden="true" className="pt-shadow" />
      <div className="pt-body relative">
        {children}
        <div aria-hidden="true" className="pt-sheen" />
      </div>
    </div>
  );
}
