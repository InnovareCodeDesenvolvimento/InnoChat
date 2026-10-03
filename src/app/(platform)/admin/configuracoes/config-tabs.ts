import { Building2, CreditCard, LogIn, Mail, Megaphone, MessageCircle, Workflow, type LucideIcon } from "lucide-react";

/**
 * Abas de /admin/configuracoes. Cada aba é uma rota própria (`/admin/configuracoes/<id>`); a pasta
 * de cada rota tem o mesmo nome do id. Segmento desconhecido cai no 404 do Next.
 */
export const CONFIG_TAB_IDS = ["geral", "whatsapp", "automacao", "pagamentos", "email", "login", "marketing"] as const;
export type ConfigTabId = (typeof CONFIG_TAB_IDS)[number];
export const DEFAULT_CONFIG_TAB: ConfigTabId = "geral";

export const CONFIG_BASE_PATH = "/admin/configuracoes";

export const CONFIG_TABS: ReadonlyArray<{ id: ConfigTabId; label: string; icon: LucideIcon; description: string }> = [
  { id: "geral", label: "Geral", icon: Building2, description: "Situação das integrações, endereços do painel e dados da empresa para os Termos e a Privacidade." },
  { id: "whatsapp", label: "WhatsApp", icon: MessageCircle, description: "A Evolution API conecta os números das empresas. O número de cobrança envia os avisos da plataforma." },
  { id: "automacao", label: "Automação (n8n)", icon: Workflow, description: "O n8n roda o bot. Aqui ficam o acesso, a sincronização, a publicação do fluxo e o segredo da API interna." },
  { id: "pagamentos", label: "Pagamentos", icon: CreditCard, description: "Mercado Pago: credenciais, ambiente e webhook da cobrança." },
  { id: "email", label: "E-mail", icon: Mail, description: "Servidor SMTP dos lembretes e avisos por e-mail, com envio de teste." },
  { id: "login", label: "Login", icon: LogIn, description: "Entrar e cadastrar a empresa com a conta Google." },
  { id: "marketing", label: "Marketing", icon: Megaphone, description: "Pixel do Meta e API de Conversões, para medir os cadastros que vêm dos anúncios." },
];

export function isConfigTabId(value: string | null | undefined): value is ConfigTabId {
  return (CONFIG_TAB_IDS as readonly string[]).includes(value ?? "");
}

/** Link direto para uma aba (e, opcionalmente, um card dela). */
export function configTabHref(tab: ConfigTabId, anchor?: string): string {
  return `${CONFIG_BASE_PATH}/${tab}${anchor ? `#${anchor}` : ""}`;
}

/** Aba a partir do caminho atual (`/admin/configuracoes/whatsapp` → `whatsapp`); `null` fora delas. */
export function configTabFromPathname(pathname: string | null | undefined): ConfigTabId | null {
  if (!pathname || !pathname.startsWith(`${CONFIG_BASE_PATH}/`)) return null;
  const segment = pathname.slice(CONFIG_BASE_PATH.length + 1).split("/")[0];
  return isConfigTabId(segment) ? segment : null;
}

/** Quais abas pedem atenção. Dados vêm do servidor no layout (leve) e se atualizam com `router.refresh()`. */
export type ConfigAttention = Partial<Record<ConfigTabId, boolean>>;
