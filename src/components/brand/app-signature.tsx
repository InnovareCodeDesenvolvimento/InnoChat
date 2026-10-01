import { cn } from "@/components/lib/cn";
import { BUILD_DATE, DESENVOLVEDORA, DESENVOLVEDORA_URL, DIREITOS_RESERVADOS, NOME_SISTEMA, VERSAO_EXIBIDA } from "@/lib/app-info";

/**
 * Assinatura em texto: "InnoChat v1.0.0 · Desenvolvido por InnovareCode", e na linha de baixo
 * "© 2026 Innovare Code. Todos os direitos reservados.".
 *
 * Para as telas públicas e de autenticação (nos painéis a identificação é o selo fixo — não
 * repetir lá, senão a versão aparece duas vezes). `tone="dark"` é para o painel de marca escuro
 * do login (`--panel-sidebar`); o padrão serve às superfícies claras.
 */
export function AppSignature({ tone = "light", className }: { tone?: "light" | "dark"; className?: string }) {
  const dark = tone === "dark";
  return (
    <p className={cn("text-xs leading-relaxed", dark ? "text-sidebar-text" : "text-text-secondary", className)}>
      <span className="font-medium">{NOME_SISTEMA}</span>{" "}
      <span
        title={`Compilado em ${BUILD_DATE}`}
        className={cn("font-semibold tabular-nums", dark ? "text-sidebar-active-text" : "text-text")}
      >
        {VERSAO_EXIBIDA}
      </span>
      <span className="sr-only">, compilado em {BUILD_DATE}</span>
      <span aria-hidden="true"> · </span>
      Desenvolvido por{" "}
      <a
        href={DESENVOLVEDORA_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          "inline-flex min-h-6 items-center font-semibold underline-offset-2 hover:underline",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
          dark ? "text-sidebar-active-text" : "text-text",
        )}
      >
        {DESENVOLVEDORA}
      </a>
      <br />
      <span data-testid="direitos-reservados">{DIREITOS_RESERVADOS}</span>
    </p>
  );
}
