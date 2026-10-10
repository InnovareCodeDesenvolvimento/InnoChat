import Image from "next/image";
import Link from "next/link";
import { CalendarCheck, BellRing, LayoutDashboard } from "lucide-react";
import { AppSignature } from "@/components/brand/app-signature";

/**
 * Casca visual das telas de autenticação (login, cadastro, recuperar/redefinir senha, convite,
 * verificar e-mail, instalação). Server Component — só CSS, sem estado; cada página embrulha o
 * próprio formulário (Client Component) com isto por fora. Tema Índigo fixo nas públicas
 * (`(public)/layout.tsx`); tudo em tokens, então acompanha qualquer tema.
 *
 * - Desktop (>= lg): tela dividida. Painel de marca escuro (~48%) com a arte do Inno num glow
 *   duplo, chip "Bot respondendo agora", título de valor e 3 benefícios em cartões de vidro; o
 *   painel é `sticky` para continuar inteiro à vista enquanto o cadastro (longo) rola.
 * - Coluna do formulário: fundo `auth-form-bg` (degradê + glow do primário + pontos), topo com
 *   wordmark e link alternativo ("Não tem conta? Criar conta"), bloco central de 28rem (cadastro:
 *   42rem) no centro óptico, assinatura no rodapé.
 * - Tablet/mobile: faixa de marca compacta no topo (recorte busto + wordmark da mesma arte) e o
 *   formulário logo abaixo — o login em 390x844 fica inteiro na primeira dobra.
 *
 * A arte foi desenhada para fundo escuro (o "Inno" do wordmark é branco, o contorno tem glow
 * azul); por isso sempre fica sobre `--panel-sidebar`, nunca sobre a superfície clara.
 * Arquivos gerados com sharp a partir de `public/marca/inno-logo.png` (1254x1254, 1,4 MB):
 * `inno-hero-960.webp` (~240 KB) e `inno-banner.webp` (recorte 1254x760, ~100 KB).
 */

const ART_ALT =
  "Inno, o robô mascote do InnoChat, de fone de ouvido, com a mão estendida como quem apresenta o sistema, ao lado do logotipo InnoChat";

const BENEFITS = [
  { icon: CalendarCheck, title: "Agenda automática", description: "O bot marca, remarca e cancela por você." },
  { icon: BellRing, title: "Lembretes e confirmações", description: "Menos faltas, sem mandar mensagem à mão." },
  { icon: LayoutDashboard, title: "Agenda à vista", description: "Abra o painel e veja quem vem hoje." },
];

export type AuthTopLink = { prompt: string; label: string; href: string };

const DEFAULT_TOP_LINK: AuthTopLink = { prompt: "Já tem conta?", label: "Entrar", href: "/login" };

/** Wordmark compacto (logo oficial, o balão "i", + nome) do topo da coluna do formulário. */
function AuthWordmark() {
  return (
    <Link
      href="/"
      className="flex items-center gap-2.5 rounded-card focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
    >
      <Image src="/marca/innochat-balao.png" alt="" width={36} height={36} className="h-9 w-9 shrink-0" />
      <span className="font-display text-lg font-extrabold tracking-tight text-text">InnoChat</span>
    </Link>
  );
}

export function AuthShell({
  children,
  formMaxWidth = "max-w-md",
  topLink = DEFAULT_TOP_LINK,
  compactMobileBrand = false,
}: {
  children: React.ReactNode;
  /** Largura do bloco central — o cadastro (mais campos, 2 colunas) usa `max-w-2xl`. */
  formMaxWidth?: "max-w-md" | "max-w-2xl";
  /** Link alternativo no canto superior direito (padrão SaaS: "Não tem conta? Criar conta"). */
  topLink?: AuthTopLink;
  /**
   * Celular: troca o banner do mascote (~8 rem) por um wordmark pequeno na mesma linha do link
   * "Já tem conta? Entrar", para o primeiro campo aparecer sem rolar. Desktop não muda.
   */
  compactMobileBrand?: boolean;
}) {
  return (
    <main className="flex min-h-screen flex-col lg:grid lg:grid-cols-[48fr_52fr]">
      {/* Painel de marca — desktop */}
      <aside className="auth-brand-bg relative hidden overflow-hidden lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col lg:items-center lg:justify-center lg:gap-6 lg:px-10 lg:pb-14 lg:pt-14 xl:gap-8 xl:px-12">
        <p className="auth-rise absolute left-8 top-7 flex items-center gap-2 rounded-full bg-white/10 py-1.5 pl-3 pr-3.5 text-xs font-medium text-sidebar-active-text ring-1 ring-white/20 backdrop-blur-md">
          <span className="relative flex h-2 w-2" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-60 motion-safe:animate-ping" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
          </span>
          Bot respondendo agora
        </p>
        <div className="auth-rise auth-float">
          <Image
            src="/marca/inno-hero-960.webp"
            alt={ART_ALT}
            width={960}
            height={960}
            priority
            unoptimized
            className="aspect-square h-[min(42vh,30rem)] w-auto select-none"
          />
        </div>
        <div className="auth-rise max-w-lg text-center" style={{ "--auth-delay": "80ms" } as React.CSSProperties}>
          <p className="font-display text-3xl font-extrabold leading-tight tracking-tight text-sidebar-active-text xl:text-4xl">
            Seu WhatsApp agendando sozinho, 24h por dia
          </p>
        </div>
        <ul
          className="auth-rise grid w-full max-w-xl grid-cols-3 gap-3"
          style={{ "--auth-delay": "160ms" } as React.CSSProperties}
        >
          {BENEFITS.map((benefit) => (
            <li
              key={benefit.title}
              className="flex flex-col gap-2 rounded-hero bg-white/[0.07] p-3.5 ring-1 ring-white/15 backdrop-blur-md xl:p-4"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-card bg-gradient-to-br from-primary/60 to-primary/20 text-sidebar-active-text ring-1 ring-white/25">
                <benefit.icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <span className="font-display text-sm font-bold leading-snug text-sidebar-active-text">
                {benefit.title}
              </span>
              <span className="text-xs leading-snug text-sidebar-text">{benefit.description}</span>
            </li>
          ))}
        </ul>
        <AppSignature tone="dark" className="absolute inset-x-6 bottom-4 text-center" />
      </aside>

      {/* Faixa de marca — tablet/mobile */}
      <header className={`auth-brand-bg-compact justify-center bg-sidebar px-4 pt-4 pb-2 lg:hidden ${compactMobileBrand ? "hidden md:flex" : "flex"}`}>
        <Image
          src="/marca/inno-banner.webp"
          alt={ART_ALT}
          width={720}
          height={436}
          unoptimized
          className="auth-rise h-[7.5rem] w-auto select-none md:h-40"
        />
      </header>

      <section className="auth-form-bg flex flex-1 flex-col px-4 pb-6 pt-2 in-data-[consent-banner=open]:pb-52 sm:px-8 sm:in-data-[consent-banner=open]:pb-6 lg:min-h-screen lg:px-10 lg:py-8 xl:px-14">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-4">
          <div className={compactMobileBrand ? "md:hidden lg:block" : "hidden lg:block"}>
            <AuthWordmark />
          </div>
          <p className="ml-auto text-sm text-text-secondary">
            {topLink.prompt}{" "}
            <Link
              href={topLink.href}
              className="inline-flex min-h-11 items-center font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              {topLink.label}
            </Link>
          </p>
        </div>
        <div className="flex flex-1 items-center justify-center py-4 lg:py-10">
          <div className={`w-full ${formMaxWidth}`}>{children}</div>
        </div>
        <AppSignature className="pt-2 text-center lg:hidden" />
      </section>
    </main>
  );
}
