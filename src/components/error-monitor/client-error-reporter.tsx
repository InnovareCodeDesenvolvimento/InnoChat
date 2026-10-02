"use client";

import { useEffect } from "react";
import { reportClientError } from "./report";

/**
 * Escuta os erros que escapam no navegador (`window.onerror` e promessa rejeitada sem tratamento) e relata ao
 * monitor. Não desenha nada. Vai uma vez em cada layout raiz.
 */
export function ClientErrorReporter() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      // Erro de extensão do navegador ou de script de outro domínio não é nosso.
      if (event.filename && /^(chrome|moz|safari)-extension:/.test(event.filename)) return;
      reportClientError(event.error ?? { name: "Error", message: event.message }, "window-error");
    };
    const onRejection = (event: PromiseRejectionEvent) => reportClientError(event.reason, "unhandled-rejection");
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
