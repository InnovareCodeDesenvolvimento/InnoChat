import { getPlatformLegalInfoAction, getPlatformSettingsAction } from "@/modules/platform/actions";
import { getPlatformWhatsappAction } from "@/modules/platform/platform-whatsapp-actions";
import { computeConfigAttention } from "./config-attention";
import { ConfigShell } from "./config-shell";

/**
 * Layout de /admin/configuracoes: título, barra de abas e o ponto de atenção de cada uma. Só lê o
 * que decide o ponto (leve); o dado de cada aba é carregado pela própria página da aba. O layout não
 * re-renderiza ao trocar de aba, então os formulários chamam `router.refresh()` depois de salvar.
 */
export default async function ConfiguracoesLayout({ children }: { children: React.ReactNode }) {
  const [settings, legal, whatsapp] = await Promise.all([
    getPlatformSettingsAction(),
    getPlatformLegalInfoAction(),
    getPlatformWhatsappAction(),
  ]);
  const attention = computeConfigAttention({
    settings: settings.ok ? settings.data : null,
    legal: legal.ok ? legal.data : null,
    whatsapp: whatsapp.ok ? whatsapp.data : null,
  });
  return <ConfigShell attention={attention}>{children}</ConfigShell>;
}
