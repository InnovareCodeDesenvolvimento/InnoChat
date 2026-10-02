"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { usePathname } from "next/navigation";

/** Tempo (ms) que os ícones "i" ficam visíveis depois de carregar/trocar de página. Ajuste aqui. */
export const HELP_VISIBLE_MS = 6000;

const HelpVisibleContext = createContext(true);

/**
 * Relógio único da página para todos os `HelpButton`: ao montar e a cada mudança de `pathname`
 * os ícones ficam visíveis por `HELP_VISIBLE_MS` e depois esmaecem (CSS em globals.css,
 * `[data-help-hidden]`). Guarda QUAL pathname expirou (em vez de um booleano) para o reinício
 * na navegação não precisar de setState síncrono dentro do efeito. Fora do provider = visível.
 */
export function HelpVisibilityProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [expiredFor, setExpiredFor] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setExpiredFor(pathname), HELP_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [pathname]);

  return <HelpVisibleContext.Provider value={expiredFor !== pathname}>{children}</HelpVisibleContext.Provider>;
}

export function useHelpVisible(): boolean {
  return useContext(HelpVisibleContext);
}
