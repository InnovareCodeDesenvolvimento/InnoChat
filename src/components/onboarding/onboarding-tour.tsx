"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { Route } from "lucide-react";
import { useReducedMotion } from "framer-motion";
import { cn } from "@/components/lib/cn";
import { Button } from "@/components/ui/button";
import { completeOnboardingTourAction, restartOnboardingTourAction } from "@/modules/onboarding/actions";
import { TOUR_STEPS, TOUR_UI } from "./inno-script";
import { TourBalloon, type BalloonLayout } from "./tour-balloon";
import { computePlacement, padRect, type Rect, type Size } from "./tour-geometry";
import {
  DESKTOP_MIN_WIDTH,
  SHEET_MAX_WIDTH,
  bodyFor,
  goBack,
  goNext,
  keyToAction,
  nextFocusIndex,
  stepsForViewport,
  targetFor,
} from "./tour-logic";

type TourContextValue = {
  /** `true` enquanto o tour está aberto (a sidebar usa isto para abrir todos os grupos). */
  active: boolean;
  start: () => void;
  /** "Rever tour": zera o estado no servidor e abre o tour do começo. */
  restart: () => Promise<void>;
};

const TourContext = createContext<TourContextValue | null>(null);

/** Fora do painel (ex.: admin da plataforma) não há provider — quem consome trata `null`. */
export function useTour(): TourContextValue | null {
  return useContext(TourContext);
}

const SEEN_KEY = "innochat:tour-seen";
const HIGHLIGHT_PAD = 6;
const FALLBACK_BALLOON: Size = { width: 360, height: 220 };

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", cb);
      return () => mql.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Primeiro elemento `data-tour` visível (o mesmo nome existe na sidebar fixa e na gaveta). */
function findTarget(name: string): HTMLElement | null {
  const nodes = document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`);
  for (const node of nodes) {
    const r = node.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return node;
  }
  return null;
}

function toRect(r: DOMRect): Rect {
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])"));
}

function persistTourResult(action: () => Promise<unknown>) {
  try {
    sessionStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* sessionStorage indisponível (modo privado): o servidor continua sendo a fonte de verdade. */
  }
  // Falha de rede/ação não pode travar o usuário fora do painel: o tour fecha de qualquer jeito.
  void action().catch(() => undefined);
}

function TourOverlay({ tenantSlug, onClose }: { tenantSlug: string; onClose: () => void }) {
  const isDesktop = useMediaQuery(`(min-width: ${DESKTOP_MIN_WIDTH}px)`);
  const isSheetWidth = useMediaQuery(`(max-width: ${SHEET_MAX_WIDTH - 1}px)`);
  const reduceMotion = useReducedMotion();

  const steps = useMemo(() => stepsForViewport(TOUR_STEPS, isDesktop), [isDesktop]);
  // O passo atual é guardado por `id`: se a janela for redimensionada e a lista de passos mudar,
  // o usuário continua no mesmo passo (ou no primeiro, se ele deixou de existir).
  const [stepId, setStepId] = useState(TOUR_STEPS[0].id);
  const index = Math.max(
    0,
    steps.findIndex((s) => s.id === stepId),
  );
  const step = steps[index];

  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const [balloonSize, setBalloonSize] = useState<Size>(FALLBACK_BALLOON);
  const [viewport, setViewport] = useState<Size>({ width: 1024, height: 768 });
  const balloonRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  const targetName = targetFor(step, isDesktop);

  const finish = useCallback(() => {
    persistTourResult(() => completeOnboardingTourAction(tenantSlug));
    onClose();
  }, [onClose, tenantSlug]);

  const go = useCallback(
    (nav: { index: number; done: boolean }) => {
      if (nav.done) {
        finish();
        return;
      }
      setStepId(steps[nav.index].id);
    },
    [steps, finish],
  );

  // Mede o alvo. Tudo agendado por rAF/timeout (nunca setState síncrono no corpo do efeito).
  useLayoutEffect(() => {
    let raf = 0;
    let observer: ResizeObserver | null = null;

    const measure = () => {
      raf = 0;
      setViewport({ width: window.innerWidth, height: window.innerHeight });
      const found = targetName ? findTarget(targetName) : null;
      setTargetRect(found ? toRect(found.getBoundingClientRect()) : null);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };

    const el = targetName ? findTarget(targetName) : null;
    schedule();
    // Grupos da sidebar abrem com animação de 200 ms: depois que assentam, garante que o alvo
    // está à vista (só rola se estiver fora da tela) e mede de novo.
    const settle = window.setTimeout(() => {
      const again = targetName ? findTarget(targetName) : null;
      if (again) {
        const r = again.getBoundingClientRect();
        if (r.top < 0 || r.bottom > window.innerHeight) again.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      schedule();
    }, 320);
    if (el) {
      observer = new ResizeObserver(schedule);
      observer.observe(el);
    }
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(settle);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [targetName, step.id]);

  // Tamanho real do balão (a altura varia com o texto de cada passo).
  useEffect(() => {
    const el = balloonRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setBalloonSize((prev) => (prev.width === r.width && prev.height === r.height ? prev : { width: r.width, height: r.height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [step.id]);

  // Trava o scroll da página, guarda/restaura o foco.
  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    // Começa do topo: a sidebar não é fixa, e o tour aponta para itens dela.
    window.scrollTo({ top: 0 });
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      const el = previouslyFocused.current;
      if (el instanceof HTMLElement && document.contains(el)) el.focus({ preventScroll: true });
    };
  }, []);

  // Foco no botão principal a cada passo (o balão é remontado por passo).
  useEffect(() => {
    const focusPrimary = () => balloonRef.current?.querySelector<HTMLElement>("[data-tour-primary]")?.focus();
    focusPrimary();
    // Se algo (ex.: o Radix devolvendo o foco ao fechar a gaveta do celular) roubar o foco logo
    // depois, o botão principal o recupera.
    const refocus = () => {
      if (!balloonRef.current?.contains(document.activeElement)) focusPrimary();
    };
    const ids = [150, 450].map((ms) => window.setTimeout(refocus, ms));
    return () => ids.forEach((id) => window.clearTimeout(id));
  }, [step.id]);

  // Teclado: setas, Esc, Ctrl+K bloqueado, Tab preso dentro do balão.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Tab") {
        const root = balloonRef.current;
        if (!root) return;
        const items = focusables(root);
        if (items.length === 0) return;
        const current = items.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        items[nextFocusIndex(current, items.length, e.shiftKey)]?.focus();
        return;
      }
      const action = keyToAction(e);
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      if (action === "next") go(goNext(index, steps.length));
      else if (action === "back") go(goBack(index));
      else if (action === "skip") finish();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [go, finish, index, steps.length]);

  const highlight = targetRect && step.kind === "step" ? padRect(targetRect, HIGHLIGHT_PAD) : null;

  let layout: BalloonLayout;
  if (step.kind !== "step") {
    layout = { kind: "center" };
  } else if (isSheetWidth) {
    layout = { kind: "sheet" };
  } else {
    const placement = computePlacement({ target: highlight, balloon: balloonSize, viewport });
    layout = placement.mode === "center" ? { kind: "center" } : { ...placement, kind: "anchored" };
  }

  return createPortal(
    <div className="fixed inset-0 z-[70]" data-tour-overlay="">
      {/* Camada que captura cliques: o usuário não mexe na tela por baixo durante o tour. */}
      <div className="absolute inset-0" aria-hidden="true" />
      {highlight ? (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute rounded-card outline outline-2 outline-white/90",
            "shadow-[0_0_0_100vmax_color-mix(in_oklab,black_58%,transparent)]",
            reduceMotion ? "" : "transition-[top,left,width,height] duration-200 ease-out",
          )}
          style={{ top: highlight.top, left: highlight.left, width: highlight.width, height: highlight.height }}
        />
      ) : (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-black/55" />
      )}
      <TourBalloon
        key={step.id}
        ref={balloonRef}
        step={step}
        body={bodyFor(step, isDesktop)}
        position={index + 1}
        total={steps.length}
        layout={layout}
        onNext={() => go(goNext(index, steps.length))}
        onBack={() => go(goBack(index))}
        onSkip={finish}
      />
    </div>,
    document.body,
  );
}

export function OnboardingTourProvider({
  tenantSlug,
  autoStart = false,
  children,
}: {
  tenantSlug: string;
  /** `true` quando o servidor viu `tourCompletedAt === null` para este usuário (1º acesso). */
  autoStart?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const autoStarted = useRef(false);

  const start = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);

  const restart = useCallback(async () => {
    // Sempre abre o tour, mesmo que zerar o estado no servidor falhe.
    void restartOnboardingTourAction(tenantSlug).catch(() => undefined);
    document.dispatchEvent(new CustomEvent("innochat:close-mobile-nav"));
    setOpen(true);
  }, [tenantSlug]);

  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    let seen = false;
    try {
      seen = sessionStorage.getItem(SEEN_KEY) === "1";
    } catch {
      seen = false;
    }
    if (seen) return;
    autoStarted.current = true;
    // Deixa a página assentar antes de o Inno aparecer.
    let fired = false;
    const id = window.setTimeout(() => {
      fired = true;
      setOpen(true);
    }, 700);
    return () => {
      window.clearTimeout(id);
      // StrictMode (dev) desmonta e remonta o effect antes do timer: libera a 2ª execução para agendar de novo.
      if (!fired) autoStarted.current = false;
    };
  }, [autoStart]);

  const value = useMemo<TourContextValue>(() => ({ active: open, start, restart }), [open, start, restart]);

  return (
    <TourContext.Provider value={value}>
      {children}
      {open ? <TourOverlay tenantSlug={tenantSlug} onClose={close} /> : null}
    </TourContext.Provider>
  );
}

/** "Rever tour" — botão discreto no rodapé da sidebar (e da gaveta no celular). */
export function TourReplayButton({ className }: { className?: string }) {
  const tour = useTour();
  if (!tour) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => void tour.restart()}
      className={cn("mt-2 w-full justify-start gap-2 px-3 text-sidebar-text hover:bg-white/10 hover:text-sidebar-active-text", className)}
    >
      <Route className="h-4 w-4 shrink-0" aria-hidden="true" />
      {TOUR_UI.replay}
    </Button>
  );
}
