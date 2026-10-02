import Link from "next/link";
import Image from "next/image";
import { AppSignature } from "@/components/brand/app-signature";
import { ConsentReopenButton } from "@/components/public/consent-reopen-button";
import { getPublicPixelId } from "@/modules/meta/config";
import { allNiches } from "./niches";

const linkClass =
  "inline-flex min-h-11 items-center rounded-card text-sm text-text-secondary underline-offset-4 transition-colors hover:text-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

/** "Preferências de cookies": só existe quando o Pixel está ligado (sem Pixel não há o que escolher). */
async function CookiePreferences() {
  if (!(await getPublicPixelId())) return null;
  return (
    <li>
      <ConsentReopenButton className={`${linkClass} cursor-pointer`} />
    </li>
  );
}

/** Rodapé: marca, navegação, conta, legal e contato (e-mail só se estiver cadastrado em Admin → Dados jurídicos). */
export function LandingFooter({ contactEmail }: { contactEmail: string | null }) {
  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr_1fr]">
          <div>
            <Link
              href="/"
              aria-label="InnoChat, início"
              className="inline-flex items-center gap-2.5 rounded-card focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
            >
              <Image src="/marca/innochat-balao.png" alt="" width={36} height={36} className="h-9 w-9 shrink-0" />
              <span className="font-display text-lg font-extrabold tracking-tight text-text">InnoChat</span>
            </Link>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-text-secondary">
              Agenda e atendimento pelo WhatsApp para negócios que vivem de horário marcado.
            </p>
          </div>

          <nav aria-label="Produto">
            <h2 className="font-display text-sm font-bold text-text">Produto</h2>
            <ul className="mt-3">
              <li><a href="#como-funciona" className={linkClass}>Como funciona</a></li>
              <li><a href="#recursos" className={linkClass}>Recursos</a></li>
              <li><a href="#planos" className={linkClass}>Planos</a></li>
              <li><a href="#faq" className={linkClass}>Perguntas frequentes</a></li>
            </ul>
          </nav>

          <nav aria-label="Para quem é">
            <h2 className="font-display text-sm font-bold text-text">Para quem é</h2>
            <ul className="mt-3">
              {allNiches().map((niche) => (
                <li key={niche.slug}>
                  <Link href={`/${niche.slug}`} className={linkClass}>
                    {niche.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-label="Conta">
            <h2 className="font-display text-sm font-bold text-text">Sua conta</h2>
            <ul className="mt-3">
              <li><Link href="/cadastro" className={linkClass}>Teste grátis</Link></li>
              <li><Link href="/login" className={linkClass}>Entrar</Link></li>
            </ul>
          </nav>

          <nav aria-label="Legal e contato">
            <h2 className="font-display text-sm font-bold text-text">Legal e contato</h2>
            <ul className="mt-3">
              <li><Link href="/termos" className={linkClass}>Termos de uso</Link></li>
              <li><Link href="/privacidade" className={linkClass}>Política de privacidade</Link></li>
              {contactEmail ? (
                <li><a href={`mailto:${contactEmail}`} className={linkClass}>{contactEmail}</a></li>
              ) : null}
              <CookiePreferences />
            </ul>
          </nav>
        </div>

        <div className="mt-10 border-t border-border pt-6 text-center sm:text-left">
          <AppSignature />
        </div>
      </div>
    </footer>
  );
}
