"use client";

import { useRef, useState } from "react";
import { useRouter, useSelectedLayoutSegment } from "next/navigation";
import { LogOut, Pencil } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { TabNav, type TabNavItem } from "@/components/ui/tab-nav";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { navIconFor } from "@/components/shell/nav-items";
import { DirtyFormsProvider, useDirtyRegistry } from "@/components/admin/settings/dirty-forms";
import { CONFIG_TABS, configTabHref, isConfigTabId, type ConfigAttention } from "./config-tabs";

/**
 * Casca de /admin/configuracoes: título ("Configurações · <aba>") com a descrição da aba, barra de
 * abas (links) e o aviso de alterações não salvas ao trocar de aba. O conteúdo de cada aba é a
 * rota filha. Trocar pela barra com formulário sujo pede confirmação; o menu lateral e o botão
 * Voltar não passam por aqui (o `beforeunload` cobre fechar/recarregar a página).
 */
export function ConfigShell({ attention, children }: { attention: ConfigAttention; children: React.ReactNode }) {
  return (
    <DirtyFormsProvider>
      <ShellInner attention={attention}>{children}</ShellInner>
    </DirtyFormsProvider>
  );
}

function ShellInner({ attention, children }: { attention: ConfigAttention; children: React.ReactNode }) {
  const router = useRouter();
  const segment = useSelectedLayoutSegment();
  const activeId = isConfigTabId(segment) ? segment : null;
  const active = CONFIG_TABS.find((t) => t.id === activeId) ?? null;
  const registry = useDirtyRegistry();
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const targetRef = useRef<string | null>(null);

  const items: TabNavItem[] = CONFIG_TABS.map((t) => ({
    id: t.id,
    href: configTabHref(t.id),
    label: t.label,
    icon: t.icon,
    active: t.id === activeId,
    attention: !!attention[t.id],
  }));

  function onItemClick(e: React.MouseEvent<HTMLAnchorElement>, item: TabNavItem) {
    if (item.active || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    if (!registry.hasDirty()) return;
    e.preventDefault();
    targetRef.current = item.href;
    setLeaveTo(item.href);
  }

  function confirmLeave() {
    const href = targetRef.current;
    registry.clear();
    setLeaveTo(null);
    if (href) router.push(href);
  }

  return (
    <div>
      <PageHeader
        icon={navIconFor("admin/configuracoes")}
        title={active ? `Configurações · ${active.label}` : "Configurações da plataforma"}
        description={active?.description ?? "Evolution, n8n, e-mail, Mercado Pago e segredo da API interna, separados por assunto."}
        className="mb-4"
      />
      <TabNav items={items} ariaLabel="Assuntos das configurações" onItemClick={onItemClick} className="mb-6" />
      {children}

      <Dialog open={leaveTo !== null} onOpenChange={(open) => !open && setLeaveTo(null)}>
        <DialogContent>
          <DialogHeader icon={Pencil} tone="warning">
            <DialogTitle>Você tem alterações não salvas</DialogTitle>
            <DialogDescription>Se trocar de aba agora, o que você digitou nesta aba se perde. Salve antes, se quiser guardar.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button icon={Pencil} type="button" variant="secondary" onClick={() => setLeaveTo(null)}>
              Continuar editando
            </Button>
            <Button icon={LogOut} type="button" variant="danger" onClick={confirmLeave}>
              Sair sem salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
