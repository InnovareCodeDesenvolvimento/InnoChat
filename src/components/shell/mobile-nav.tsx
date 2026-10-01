"use client";

import { useEffect, useState } from "react";
import { Menu } from "lucide-react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/lib/cn";
import { TenantSidebarNav, AdminSidebarNav } from "./sidebar-nav";

type MobileNavProps = {
  brand: React.ReactNode;
  footer: React.ReactNode;
} & (
  | { variant: "tenant"; tenantSlug: string; onboardingIncomplete?: boolean; whatsappNeedsAttention?: boolean; billingOnly?: boolean }
  | { variant: "admin" }
);

/**
 * Hambúrguer + gaveta (drawer) para telas < 1024px (`lg`). Recebe `brand` e
 * `footer` já renderizados pelo Server Component pai (composição via
 * children/prop é permitida — o que não pode cruzar a fronteira
 * servidor/cliente é o array de itens com ícone, por isso a navegação é
 * resolvida aqui dentro por `variant`, não recebida como prop).
 *
 * Animação com `framer-motion` (não os utilitários `animate-in`/`fade-in` do Tailwind, que este
 * projeto não tem plugin para — ver `ui/dialog.tsx`, onde essas classes já existiam mas nunca
 * fizeram nada; não repito a mesma armadilha aqui).
 */
export function MobileNav(props: MobileNavProps) {
  const [open, setOpen] = useState(false);
  const reduceMotion = useReducedMotion();

  // O tour do Inno ("Rever tour" no rodapé da gaveta) precisa da gaveta fechada: o diálogo modal
  // do Radix prende o foco e brigaria com o balão.
  useEffect(() => {
    const close = () => setOpen(false);
    document.addEventListener("innochat:close-mobile-nav", close);
    return () => document.removeEventListener("innochat:close-mobile-nav", close);
  }, []);

  return (
    <RadixDialog.Root open={open} onOpenChange={setOpen}>
      <RadixDialog.Trigger asChild>
        <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Abrir menu" data-tour="menu-button">
          <Menu className="h-5 w-5" aria-hidden="true" />
        </Button>
      </RadixDialog.Trigger>
      <AnimatePresence>
        {open ? (
          <RadixDialog.Portal forceMount>
            <RadixDialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm lg:hidden"
                initial={reduceMotion ? undefined : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={reduceMotion ? undefined : { opacity: 0 }}
                transition={{ duration: 0.15 }}
              />
            </RadixDialog.Overlay>
            <RadixDialog.Content asChild forceMount>
              <motion.div
                className={cn(
                  "panel-sidebar-surface-glass fixed inset-y-0 left-0 z-50 flex w-72 flex-col px-4 py-6 lg:hidden",
                  "focus:outline-none",
                )}
                initial={reduceMotion ? undefined : { x: "-100%" }}
                animate={{ x: 0 }}
                exit={reduceMotion ? undefined : { x: "-100%" }}
                transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              >
                <RadixDialog.Title className="sr-only">Menu de navegação</RadixDialog.Title>
                <div className="mb-8 px-2">{props.brand}</div>
                <div className="flex-1 overflow-y-auto">
                  {props.variant === "tenant" ? (
                    <TenantSidebarNav
                      tenantSlug={props.tenantSlug}
                      onboardingIncomplete={props.onboardingIncomplete}
                      whatsappNeedsAttention={props.whatsappNeedsAttention}
                      billingOnly={props.billingOnly}
                      onNavigate={() => setOpen(false)}
                    />
                  ) : (
                    <AdminSidebarNav onNavigate={() => setOpen(false)} />
                  )}
                </div>
                {/* Clique em link do rodapé (ex.: "Minha conta" no bloco do usuário) fecha a gaveta. */}
                <div
                  className="mt-4 border-t border-white/10 pt-4"
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest("a")) setOpen(false);
                  }}
                >
                  {props.footer}
                </div>
              </motion.div>
            </RadixDialog.Content>
          </RadixDialog.Portal>
        ) : null}
      </AnimatePresence>
    </RadixDialog.Root>
  );
}
