"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";

/**
 * Registro de formulários com alterações não salvas, para a navegação entre as abas de
 * /admin/configuracoes (cada aba é uma rota: ao trocar, o que foi digitado se perde).
 * Cada formulário chama `useReportDirty(id, dirty)`; o shell consulta antes de trocar de aba e
 * antes de fechar/recarregar a página (`beforeunload`). Fora do provider é um no-op.
 */

type DirtyRegistry = {
  report: (id: string, dirty: boolean) => void;
  hasDirty: () => boolean;
  clear: () => void;
};

const NOOP: DirtyRegistry = { report: () => {}, hasDirty: () => false, clear: () => {} };
const DirtyContext = createContext<DirtyRegistry>(NOOP);

export function DirtyFormsProvider({ children }: { children: React.ReactNode }) {
  const idsRef = useRef(new Set<string>());
  const report = useCallback((id: string, dirty: boolean) => {
    if (dirty) idsRef.current.add(id);
    else idsRef.current.delete(id);
  }, []);
  const hasDirty = useCallback(() => idsRef.current.size > 0, []);
  const clear = useCallback(() => idsRef.current.clear(), []);
  const value = useMemo<DirtyRegistry>(() => ({ report, hasDirty, clear }), [report, hasDirty, clear]);

  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!idsRef.current.size) return;
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  return <DirtyContext.Provider value={value}>{children}</DirtyContext.Provider>;
}

export function useDirtyRegistry(): DirtyRegistry {
  return useContext(DirtyContext);
}

/** Avisa o shell que este formulário está (ou deixou de estar) com alterações não salvas. */
export function useReportDirty(id: string, dirty: boolean) {
  const { report } = useContext(DirtyContext);
  useEffect(() => {
    report(id, dirty);
    return () => report(id, false);
  }, [id, dirty, report]);
}
