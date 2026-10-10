"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Cookie } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  CONSENT_REOPEN_EVENT,
  clearConsent,
  loadPixel,
  readConsent,
  revokePixel,
  stripQueryFromLocation,
  trackPixel,
  writeConsent,
  type ConsentChoice,
} from "./meta-events";

/**
 * Pixel do Meta + banner de consentimento (LGPD). Montado só nas páginas públicas de venda
 * (landing, nichos, cadastro) e só quando o Admin ligou o Pixel. O script da Meta NÃO é pedido
 * antes do "Aceitar"; "Recusar" grava a escolha e nada é carregado. Nas próximas visitas a escolha
 * é lembrada (localStorage) e o banner não volta, a não ser pelo link "Preferências de cookies".
 */
export function MetaPixel({ pixelId, stripQuery = false }: { pixelId: string; stripQuery?: boolean }) {
  const [choice, setChoice] = useState<ConsentChoice | null>(null);
  const [ready, setReady] = useState(false);
  const [reopened, setReopened] = useState(false);
  const firstActionRef = useRef<HTMLButtonElement>(null);

  // Leitura do armazenamento só no cliente, depois da hidratação (evita diferença servidor x cliente).
  useEffect(() => {
    const timer = setTimeout(() => {
      setChoice(readConsent());
      setReady(true);
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    function reopen() {
      clearConsent();
      revokePixel();
      setChoice(null);
      setReopened(true);
    }
    window.addEventListener(CONSENT_REOPEN_EVENT, reopen);
    return () => window.removeEventListener(CONSENT_REOPEN_EVENT, reopen);
  }, []);

  // Aceitou: carrega o Pixel e conta a visita desta página.
  useEffect(() => {
    if (choice !== "granted") return;
    // O Pixel manda a URL da página à Meta: no cadastro ela sai sem query (nada de e-mail, nome ou token).
    if (stripQuery) stripQueryFromLocation();
    loadPixel(pixelId);
    trackPixel("PageView");
  }, [choice, pixelId, stripQuery]);

  // Banner reaberto pelo rodapé leva o foco para dentro (quem pediu está no teclado ou no leitor de tela).
  useEffect(() => {
    if (ready && reopened && choice === null) firstActionRef.current?.focus();
  }, [ready, reopened, choice]);

  // Avisa a página que o banner (fixo na base da tela) está aberto: o cadastro ganha folga embaixo
  // para o botão nunca ficar escondido atrás dele (`in-data-[consent-banner=open]` no AuthShell).
  const bannerOpen = ready && choice === null;
  useEffect(() => {
    if (!bannerOpen) return;
    document.documentElement.dataset.consentBanner = "open";
    return () => {
      delete document.documentElement.dataset.consentBanner;
    };
  }, [bannerOpen]);

  const decide = useCallback((next: ConsentChoice) => {
    writeConsent(next);
    if (next === "denied") revokePixel();
    setChoice(next);
    setReopened(false);
  }, []);

  if (!ready || choice !== null) return null;

  return (
    <section
      aria-labelledby="consent-title"
      data-testid="consent-banner"
      className="fixed inset-x-3 bottom-3 z-50 sm:inset-x-auto sm:bottom-5 sm:left-5 sm:w-[26rem]"
    >
      <div className="rounded-hero border border-border bg-surface p-4 shadow-2xl sm:p-5">
        <div className="flex items-start gap-3">
          <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Cookie className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 id="consent-title" className="font-display text-sm font-bold text-text">
              Posso medir de onde você chegou?
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-text-secondary">
              Usamos o Pixel do Meta para saber qual anúncio trouxe você até aqui. Só ligamos se você deixar. Os detalhes estão na{" "}
              <Link
                href="/privacidade#cookies"
                className="font-semibold text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                Política de privacidade
              </Link>
              .
            </p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button ref={firstActionRef} type="button" variant="secondary" onClick={() => decide("denied")}>
            Recusar
          </Button>
          <Button type="button" onClick={() => decide("granted")}>
            Aceitar
          </Button>
        </div>
      </div>
    </section>
  );
}
