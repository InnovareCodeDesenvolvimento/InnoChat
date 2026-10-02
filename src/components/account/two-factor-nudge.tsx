"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ShieldCheck, X } from "lucide-react";

const DISMISS_KEY = "innochat:2fa-nudge-dismissed";

const subscribe = () => () => {};
function readDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Convite discreto para o dono ligar a verificação em 2 etapas (opcional para ele). Uma faixa
 * fina no topo do conteúdo; "Agora não" esconde até fechar a aba. Some na própria tela Minha conta.
 */
export function TwoFactorNudge({ href }: { href: string }) {
  const pathname = usePathname();
  // No servidor (e na hidratação) começa escondido; no navegador lê o que foi dispensado nesta aba.
  const storedDismissed = useSyncExternalStore(subscribe, readDismissed, () => true);
  const [dismissedNow, setDismissedNow] = useState(false);
  const hidden = storedDismissed || dismissedNow;

  if (hidden || pathname.endsWith("/minha-conta")) return null;

  return (
    <div
      data-testid="two-factor-nudge"
      className="mb-4 flex items-center gap-3 rounded-card border border-border bg-surface px-4 py-2.5 text-sm text-text-secondary"
    >
      <ShieldCheck className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        Proteja o seu acesso com a verificação em 2 etapas.{" "}
        <Link href={href} className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
          Ativar agora
        </Link>
      </p>
      <button
        type="button"
        onClick={() => {
          try {
            window.sessionStorage.setItem(DISMISS_KEY, "1");
          } catch {
            /* sem storage: só esconde nesta tela */
          }
          setDismissedNow(true);
        }}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-card text-text-secondary hover:bg-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        aria-label="Agora não"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
