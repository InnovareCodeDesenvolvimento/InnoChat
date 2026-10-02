import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bot,
  Bug,
  Building2,
  BarChart3,
  Calendar,
  CircleUser,
  ClipboardList,
  DatabaseBackup,
  CreditCard,
  LayoutDashboard,
  Headset,
  Hourglass,
  Layers,
  MessageCircle,
  Receipt,
  Rocket,
  Scissors,
  Send,
  Settings,
  UserRound,
  TicketPercent,
  Users,
  Wallet,
} from "lucide-react";

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Ponto de alerta discreto (ex.: número de WhatsApp desconectado) — sempre um booleano vindo
   * do servidor, nunca um ícone cruzando a fronteira servidor/cliente (ver nota no topo deste
   * arquivo/`sidebar-nav.tsx`). */
  dot?: boolean;
  /** Contador (badge) que o cliente lê do polling de notificações — hoje só "attendance" (fila de
   * atendimento). É uma CHAVE, não um número: o valor muda a cada poll e vem do contexto no client. */
  badge?: "attendance";
};

export type NavGroup = {
  id: string;
  label: string;
  items: NavItem[];
};

/**
 * Agrupamento da sidebar (docs/design/premium-spec.md §1/§2/§11, escopo combinado com o dono):
 * navegação colapsável — grupos fixos e sempre abertos (padrão anterior) ficam ruins quando há
 * 9+ seções. "Início" abre o grupo Operação porque é onde o dono passa mais tempo no dia a dia.
 */
const TENANT_GROUPS_DEF: { id: string; label: string; items: { label: string; path: string; icon: LucideIcon; ownerOnly?: boolean }[] }[] = [
  {
    id: "operacao",
    label: "Operação",
    items: [
      { label: "Início", path: "inicio", icon: LayoutDashboard },
      { label: "Atendimento", path: "atendimento", icon: Headset },
      { label: "Agenda", path: "agenda", icon: Calendar },
      { label: "Agendamentos", path: "agendamentos", icon: ClipboardList },
      { label: "Lista de espera", path: "lista-de-espera", icon: Hourglass },
      { label: "Clientes", path: "clientes", icon: Users },
      { label: "Relatórios", path: "relatorios", icon: BarChart3, ownerOnly: true },
    ],
  },
  {
    id: "catalogo",
    label: "Catálogo",
    items: [
      { label: "Serviços", path: "servicos", icon: Scissors },
      { label: "Profissionais", path: "profissionais", icon: UserRound },
    ],
  },
  {
    id: "canal",
    label: "Canal",
    items: [
      { label: "WhatsApp", path: "whatsapp", icon: MessageCircle },
      { label: "Mensagens do bot", path: "mensagens-bot", icon: Bot },
    ],
  },
  {
    id: "conta",
    label: "Conta",
    items: [
      { label: "Configurações", path: "configuracoes", icon: Settings },
      { label: "Assinatura", path: "assinatura", icon: CreditCard },
    ],
  },
];

/**
 * `includeOnboarding` (docs/arquitetura.md §13, decisão do dono): o link para o assistente de
 * primeiros passos só aparece enquanto a configuração inicial não está completa. Fica FORA dos
 * grupos colapsáveis (item fixado no topo) — é uma tarefa temporária, não uma seção do produto,
 * então não faz sentido poder escondê-la atrás de um grupo fechado.
 */
export function tenantOnboardingItem(tenantSlug: string): NavItem | null {
  return { label: "Primeiros passos", icon: navIconFor("onboarding"), href: `/${tenantSlug}/onboarding` };
}

export function tenantNavGroups(
  tenantSlug: string,
  options: { whatsappNeedsAttention?: boolean; isOwner?: boolean } = {},
): NavGroup[] {
  const isOwner = options.isOwner ?? true;
  return TENANT_GROUPS_DEF.map((group) => ({
    id: group.id,
    label: group.label,
    items: group.items.filter((item) => isOwner || !item.ownerOnly).map(({ label, path, icon }) => ({
      label,
      icon,
      href: `/${tenantSlug}/${path}`,
      dot: path === "whatsapp" && !!options.whatsappNeedsAttention,
      badge: path === "atendimento" ? ("attendance" as const) : undefined,
    })),
  }));
}

/** Lista plana — usada pela paleta de comando e por `section-label.tsx` (não precisam de grupo). */
export function tenantNavItems(
  tenantSlug: string,
  options: { includeOnboarding?: boolean; whatsappNeedsAttention?: boolean; isOwner?: boolean } = {},
): NavItem[] {
  const items = tenantNavGroups(tenantSlug, options).flatMap((g) => g.items);
  const onboarding = options.includeOnboarding ? tenantOnboardingItem(tenantSlug) : null;
  return onboarding ? [onboarding, ...items] : items;
}

/** Grupos da sidebar do admin da plataforma (docs/arquitetura.md §9, "Plataforma"). */
const ADMIN_GROUPS_DEF: { id: string; label: string; items: { label: string; href: string; icon: LucideIcon }[] }[] = [
  {
    id: "operacao",
    label: "Operação",
    items: [
      { label: "Empresas", href: "/admin/empresas", icon: Building2 },
    ],
  },
  {
    // Decisão do dono (2026-10-02): "Financeiro" com Cobranças e Envios de cobrança como submenu.
    id: "financeiro",
    label: "Financeiro",
    items: [
      { label: "Visão geral", href: "/admin/financeiro", icon: Wallet },
      { label: "Cobranças", href: "/admin/cobranca", icon: Receipt },
      { label: "Envios de cobrança", href: "/admin/envios", icon: Send },
      { label: "Cupons", href: "/admin/cupons", icon: TicketPercent },
    ],
  },
  {
    id: "plataforma",
    label: "Plataforma",
    items: [
      { label: "Planos", href: "/admin/planos", icon: Layers },
      { label: "Configurações da plataforma", href: "/admin/configuracoes", icon: Settings },
      { label: "Saúde", href: "/admin/saude", icon: Activity },
      { label: "Backup", href: "/admin/backup", icon: DatabaseBackup },
      { label: "Erros", href: "/admin/erros", icon: Bug },
    ],
  },
];

export const adminNavGroups: NavGroup[] = ADMIN_GROUPS_DEF;

export const adminNavItems: NavItem[] = ADMIN_GROUPS_DEF.flatMap((g) => g.items);

/**
 * Fonte única dos ícones de página: o `PageHeader` mostra o MESMO ícone que a seção tem no menu
 * lateral (confirma onde a pessoa está). Chave = segmento do caminho no painel da empresa
 * (`"agenda"`, `"onboarding"`) ou o caminho completo no admin (`"admin/empresas"`). Subpáginas e
 * detalhes usam a chave da seção-mãe (ex.: `"configuracoes"` para Equipe, `"profissionais"` para o
 * detalhe). Chave desconhecida lança — melhor quebrar no build/teste do que exibir cabeçalho sem
 * ícone em silêncio.
 */
const ICON_BY_KEY: Record<string, LucideIcon> = {
  onboarding: Rocket,
  // Fora do menu: abre pelo bloco do usuário na sidebar.
  "minha-conta": CircleUser,
  "admin/minha-conta": CircleUser,
  ...Object.fromEntries(TENANT_GROUPS_DEF.flatMap((g) => g.items.map((i) => [i.path, i.icon] as const))),
  ...Object.fromEntries(ADMIN_GROUPS_DEF.flatMap((g) => g.items.map((i) => [i.href.replace(/^\//, ""), i.icon] as const))),
};

export function navIconFor(key: string): LucideIcon {
  const icon = ICON_BY_KEY[key];
  if (!icon) throw new Error(`navIconFor: sem ícone de menu para "${key}"`);
  return icon;
}

export const NAV_ICON_KEYS: string[] = Object.keys(ICON_BY_KEY);
