"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/cn";
import { GoogleLogo } from "@/components/public/google-button";

/** Quanto esperar antes de achar que o navegador do sistema não abriu e mostrar o passo manual. */
const OPEN_TIMEOUT_MS = 1500;
/** No iPhone o Instagram costuma ignorar o `x-safari-https://` (teste real em 2026-10-10): o guia aparece quase na hora. */
const IOS_OPEN_TIMEOUT_MS = 500;

/** O mesmo endereço em https, para copiar e colar no navegador (tira o esquema do iOS ou lê o fallback do Android). */
export function plainHttpsUrl(href: string): string {
  if (href.startsWith("x-safari-https://")) return `https://${href.slice("x-safari-https://".length)}`;
  const fallback = /S.browser_fallback_url=([^;]+)/.exec(href);
  if (href.startsWith("intent://") && fallback) {
    try {
      return decodeURIComponent(fallback[1]);
    } catch {
      return href;
    }
  }
  return href;
}

/**
 * "Continuar com Google" para quem está no navegador embutido do Instagram/Facebook, onde o Google
 * recusa o login. Em vez do botão do Google, é um link que abre a mesma página no navegador do
 * sistema (o endereço já vem pronto do servidor, com cupom e parâmetros de campanha), e lá o Google
 * inicia sozinho. Se em ~1,5 s a página continua à vista (o sistema não abriu), mostra o passo manual.
 */
export function GoogleExternalButton({ href, label = "Continuar com Google" }: { href: string; label?: string }) {
  const [showHint, setShowHint] = useState(false);
  const [copied, setCopied] = useState(false);
  const isIos = href.startsWith("x-safari-https://");
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
    }, isIos ? IOS_OPEN_TIMEOUT_MS : OPEN_TIMEOUT_MS);
  }

  async function copyLink() {
    const url = plainHttpsUrl(href);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Sem permissão de área de transferência: mostra o endereço para a pessoa copiar na mão.
      window.prompt("Copie o link e cole no Safari ou no Chrome:", url);
    }
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
        <div role="status" className="flex flex-col gap-2 rounded-card bg-warning-bg px-4 py-3 text-sm text-warning" data-testid="cadastro-google-externo-dica">
          <p className="font-medium">O Instagram não deixou abrir sozinho. Leva 2 toques:</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              Toque em <strong>⋯</strong> no canto de cima da tela.
            </li>
            <li>
              Escolha <strong>{isIos ? "Abrir no navegador externo" : "Abrir no Chrome"}</strong>. O Google começa lá.
            </li>
          </ol>
          <p>Se preferir, copie o link e cole no {isIos ? "Safari" : "Chrome"}:</p>
          <button
            type="button"
            onClick={copyLink}
            className="h-11 rounded-card border border-current bg-white px-4 font-medium text-[#1f1f1f]"
            data-testid="cadastro-google-externo-copiar"
          >
            {copied ? "Link copiado ✓" : "Copiar link"}
          </button>
          <p className="text-xs">Ou cadastre aqui mesmo com e-mail e senha, logo acima. É rapidinho.</p>
        </div>
      ) : null}
    </div>
  );
}
