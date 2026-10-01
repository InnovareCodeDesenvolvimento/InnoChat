import Link from "next/link";
import { LogoutButton } from "./logout-button";

/**
 * Bloco de usuário no rodapé da sidebar (docs/design/premium-spec.md §1/§2) — nome/e-mail e
 * "Sair" juntos. A parte da esquerda é um link para "Minha conta" (alvo de 44px). Sem nome
 * cadastrado, mostra só o e-mail (comportamento anterior).
 */
export function UserBlock({
  userEmail,
  userName = null,
  accountHref,
}: {
  userEmail: string;
  userName?: string | null;
  accountHref: string;
}) {
  const label = userName?.trim() || userEmail;
  return (
    <div data-tour="user-block" className="flex items-center gap-1 rounded-card border border-white/10 bg-white/5 p-1">
      <Link
        href={accountHref}
        aria-label={`Minha conta de ${label}`}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-card px-1.5 text-left transition-colors duration-150 hover:bg-white/10 motion-reduce:transition-none"
      >
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-bold text-sidebar-text"
        >
          {(label[0] ?? "?").toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold text-sidebar-text">{label}</span>
          {userName?.trim() ? <span className="block truncate text-[11px] text-sidebar-text/70">{userEmail}</span> : null}
        </span>
      </Link>
      <LogoutButton iconOnly className="shrink-0 text-sidebar-text hover:bg-white/10" />
    </div>
  );
}
