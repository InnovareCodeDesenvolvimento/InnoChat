"use client";

import { useEffect } from "react";
import { reportClientError } from "@/components/error-monitor/report";

/**
 * Último recurso: erro que derruba até o layout. Como não há layout raiz único (cada grupo tem o seu), esta tela traz
 * o próprio `<html>` e fica sem os componentes do painel, só com estilo mínimo. Relata só erro sem `digest` (com digest
 * o servidor já registrou).
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    if (!error.digest) reportClientError(error, "boundary");
  }, [error]);

  return (
    <html lang="pt-BR">
      <body style={{ fontFamily: "system-ui, sans-serif", display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", margin: 0, padding: 24 }}>
        <div style={{ maxWidth: 420, textAlign: "center" }}>
          <h1 style={{ fontSize: 20 }}>Algo deu errado</h1>
          <p style={{ color: "#555" }}>Já avisamos a equipe. Tente de novo; se continuar, volte daqui a pouco.</p>
          <button type="button" onClick={reset} style={{ padding: "10px 18px", borderRadius: 8, border: "1px solid #999", background: "#fff", cursor: "pointer" }}>
            Tentar de novo
          </button>
        </div>
      </body>
    </html>
  );
}
