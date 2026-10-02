"use client";

import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { reportClientError } from "./report";

/**
 * Tela de erro dos error boundaries (`error.tsx`). Relata ao monitor SÓ quando o erro não tem `digest`: com `digest`
 * foi um erro de servidor, que o `onRequestError` já registrou (relatar de novo contaria em dobro).
 */
export function ErrorBoundaryView({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    if (!error.digest) reportClientError(error, "boundary");
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-xl items-center justify-center p-6">
      <EmptyState
        icon={TriangleAlert}
        title="Algo deu errado nesta tela"
        description="Já avisamos a equipe. Tente de novo; se continuar, volte daqui a pouco."
        action={
          <Button type="button" onClick={reset}>
            Tentar de novo
          </Button>
        }
      />
    </div>
  );
}
