"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/cn";
import { GoogleLogo } from "@/components/public/google-button";

/** Quanto esperar antes de achar que o navegador do sistema não abriu e mostrar o passo manual. */
const OPEN_TIMEOUT_MS = 1500;

/**
 * "Continuar com Google" para quem está no navegador embutido do Instagram/Facebook, onde o Google
 * recusa o login. Em vez do botão do Google, é um link que abre a mesma página no navegador do
 * sistema (o endereço já vem pronto do servidor, com cupom e parâmetros de campanha), e lá o Google
 * inicia sozinho. Se em ~1,5 s a página continua à vista (o sistema não abriu), mostra o passo manual.
 */
export function GoogleExternalButton({ href, label = "Continuar com Google" }: { href: string; label?: string }) {
  const [showHint, setShowHint] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Saiu da página (o outro navegador abriu): cancela o aviso, para ele não aparecer ao voltar.
    function cancel() {
      if (document.hidden && timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    }
    document.addEventListener("visibilitychange", cancel);
    window.addEventListener("pagehide", cancel);
    return () => {
      document.removeEventListener("visibilitychange", cancel);
      window.removeEventListener("pagehide", cancel);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function handleClick() {
    setShowHint(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (!document.hidden) setShowHint(true);
    }, OPEN_TIMEOUT_MS);
  }

  return (
    <div className="flex flex-col gap-2" data-testid="cadastro-google-externo">
      <a
        href={href}
        onClick={handleClick}
        data-testid="cadastro-google-externo-link"
        className={cn(
          "inline-flex h-12 w-full items-center justify-center gap-3 rounded-card border border-[#747775] bg-white px-4",
          "text-base font-medium text-[#1f1f1f] transition-colors hover:bg-[#f2f2f2] active:bg-[#e8e8e8]",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary motion-reduce:transition-none",
        )}
      >
        <GoogleLogo />
        <span>{label}</span>
      </a>
      <p className="text-center text-xs leading-relaxed text-text-secondary">O Google abre no navegador do celular, fora do Instagram.</p>
      {showHint ? (
        <p role="status" className="rounded-card bg-warning-bg px-3 py-2 text-center text-sm text-warning" data-testid="cadastro-google-externo-dica">
          Não abriu? Toque em ⋯ e depois em Abrir no navegador.
        </p>
      ) : null}
    </div>
  );
}
