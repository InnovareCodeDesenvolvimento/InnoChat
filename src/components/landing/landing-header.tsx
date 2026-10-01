import Link from "next/link";
import Image from "next/image";
import { Button } from "@/components/ui/button";

const LINKS = [
  { href: "#como-funciona", label: "Como funciona" },
  { href: "#recursos", label: "Recursos" },
  { href: "#planos", label: "Planos" },
  { href: "#faq", label: "Perguntas" },
];

/**
 * Header fixo em vidro escuro (a hero é escura; nas seções claras o vidro continua legível por
 * ser sempre `bg-sidebar` translúcido + blur). Server Component — as âncoras são links nativos.
 * No celular as âncoras somem (cabem só a marca, "Entrar" e o teste grátis); o conteúdo é uma
 * página única, então a rolagem substitui o menu.
 */
export function LandingHeader() {
  return (
    <header className="fixed inset-x-0 top-0 z-40 border-b border-white/10 bg-sidebar/75 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
        <Link
          href="/"
          aria-label="InnoChat, início"
          className="flex items-center gap-2.5 rounded-card focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sidebar-active-text"
        >
          <Image src="/marca/innochat-balao.png" alt="" width={36} height={36} className="h-9 w-9 shrink-0" />
          <span className="font-display text-lg font-extrabold tracking-tight text-sidebar-active-text">InnoChat</span>
        </Link>

        <nav aria-label="Seções da página" className="hidden items-center gap-1 md:flex">
          {LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="inline-flex min-h-11 items-center rounded-card px-3 text-sm font-medium text-sidebar-text transition-colors hover:bg-white/10 hover:text-sidebar-active-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-active-text"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-1.5 sm:gap-2">
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="text-sidebar-active-text hover:bg-white/10 focus-visible:outline-sidebar-active-text"
          >
            <Link href="/login">Entrar</Link>
          </Button>
          <Button asChild size="sm" className="shadow-lg shadow-primary/40 focus-visible:outline-sidebar-active-text">
            <Link href="/cadastro">Teste grátis</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
