"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { Card, CardContent } from "@/components/ui/card";
import { HelpButton } from "@/components/help/help-button";
import type { HelpKey } from "@/components/help/help-content";
import { STAGGER_DELAY_S } from "@/components/lib/motion";

export type ConfigSection = {
  href: string;
  /**
   * Elemento JÁ RENDERIZADO (ex.: `<Palette aria-hidden="true" />`), nunca o COMPONENTE
   * (`LucideIcon`) — este é um Client Component (`motion.div`) e quem o chama é sempre um Server
   * Component (`page.tsx`). Passar a função do ícone como prop quebra o build ("Only plain
   * objects can be passed to Client Components from Server Components"), a mesma armadilha já
   * registrada na memória (`nav-items.ts`/`sidebar-nav.tsx`, `stat-card.tsx`).
   */
  icon: React.ReactNode;
  title: string;
  description: string;
  ready: boolean;
  /** Caminho completo depois do slug (ex.: `assinatura#contato-de-cobranca`), quando o destino não fica em /configuracoes/<href>. */
  to?: string;
  /** Texto de ajuda do destino (só para cards que já funcionam). */
  help?: HelpKey;
};

/**
 * Grade de cards do índice de Configurações (docs/design/screens/premium/onda2) — selo
 * circular tingido, hover com borda/sombra ganhando cor, entrada escalonada por índice. Cliente
 * só por causa do `motion` — o conteúdo (`SECTIONS`) continua vindo do Server Component pai.
 */
export function ConfiguracoesGrid({ tenantSlug, sections }: { tenantSlug: string; sections: ConfigSection[] }) {
  const reduceMotion = useReducedMotion();

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {sections.map((section, index) => (
        <motion.div
          key={section.href}
          initial={reduceMotion ? undefined : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, delay: index * STAGGER_DELAY_S, ease: [0.16, 1, 0.3, 1] }}
        >
          <Card
            className={
              section.ready
                ? "group rounded-hero transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-card-hover motion-reduce:transition-none motion-reduce:hover:translate-y-0"
                : "rounded-hero opacity-60"
            }
          >
            <CardContent className="relative">
              {section.help ? <HelpButton helpKey={section.help} placement="corner" className="right-2 top-2" /> : null}
              <div
                className={
                  section.ready
                    ? "flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary transition-transform duration-200 group-hover:scale-110 motion-reduce:transition-none motion-reduce:group-hover:scale-100 [&>svg]:h-5 [&>svg]:w-5"
                    : "flex h-11 w-11 items-center justify-center rounded-full bg-bg text-text-secondary [&>svg]:h-5 [&>svg]:w-5"
                }
              >
                {section.icon}
              </div>
              <p className="mt-3 font-display text-sm font-bold text-text">{section.title}</p>
              <p className="mt-1 text-sm text-text-secondary">{section.description}</p>
              {section.ready ? (
                <Link
                  href={section.to ? `/${tenantSlug}/${section.to}` : `/${tenantSlug}/configuracoes/${section.href}`}
                  className="mt-3 inline-block text-sm font-medium text-primary hover:underline"
                >
                  Abrir
                </Link>
              ) : (
                <p className="mt-3 text-xs text-text-secondary">Chega em uma próxima fase.</p>
              )}
            </CardContent>
          </Card>
        </motion.div>
      ))}
    </div>
  );
}
