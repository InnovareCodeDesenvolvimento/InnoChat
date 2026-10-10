import { Gift, ShieldCheck } from "lucide-react";
import { cn } from "@/components/lib/cn";

/**
 * Bloco central das telas de autenticação: título grande em `font-display` + subtítulo, sem
 * cabeçalho separado por linha. A superfície é semitransparente (o gradiente da coluna aparece
 * por trás) e usa só tokens do tema. Server Component.
 */
export function AuthPanel({
  title,
  description,
  children,
  className,
  compact = false,
}: {
  title?: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Cabeçalho mais junto do formulário (cadastro no celular: o primeiro campo precisa caber na primeira tela). */
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-hero bg-surface/85 p-6 shadow-card-hover ring-1 ring-border backdrop-blur-md sm:p-8",
        className,
      )}
    >
      {title ? (
        <div className={compact ? "mb-4 sm:mb-6" : "mb-6"}>
          <h1 className="font-display text-2xl font-extrabold leading-tight tracking-tight text-text sm:text-3xl">
            {title}
          </h1>
          {description ? <p className="mt-2 text-sm leading-relaxed text-text-secondary sm:text-base">{description}</p> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** Selos discretos de confiança, abaixo do botão principal. */
export function AuthTrust({ trial = false }: { trial?: boolean }) {
  return (
    <ul className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-text-secondary">
      <li className="flex items-center gap-1.5">
        <ShieldCheck className="h-4 w-4 text-success" aria-hidden="true" />
        Dados protegidos · LGPD
      </li>
      {trial ? (
        <li className="flex items-center gap-1.5">
          <Gift className="h-4 w-4 text-primary" aria-hidden="true" />
          Teste grátis de 3 dias, sem cartão
        </li>
      ) : null}
    </ul>
  );
}

/** Classes do botão principal das telas de autenticação (gradiente + sombra tingida). */
export const AUTH_SUBMIT_CLASS =
  "mt-2 w-full bg-gradient-to-b from-primary to-primary-strong text-base font-semibold shadow-lg shadow-primary/30 " +
  "hover:brightness-110 hover:shadow-primary/40";
