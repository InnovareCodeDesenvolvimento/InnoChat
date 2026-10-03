import type { PlatformSettingsView } from "@/modules/platform/service";
import type { PlatformLegalInfo } from "@/core/legal/placeholders";
import type { PlatformWhatsappState } from "@/modules/platform/platform-whatsapp-actions";
import type { ConfigAttention } from "./config-tabs";

/** "Completo" = os 9 campos preenchidos (o mesmo texto que `/termos` e `/privacidade` usam). */
export function isLegalInfoComplete(info: PlatformLegalInfo): boolean {
  return (
    !!info.companyLegalName &&
    !!info.companyCnpj &&
    !!info.companyAddress &&
    !!info.contactEmail &&
    !!info.dpoName &&
    !!info.dpoEmail &&
    !!info.forumCity &&
    !!info.hostingRegion &&
    info.backupRetentionDays != null
  );
}

/**
 * Quais abas mostram o ponto de atenção. Só entra o que já é um estado conhecido da tela:
 * Evolution sem URL/chave ou WhatsApp de cobrança ligado sem número conectado (WhatsApp), n8n sem
 * URL/chave (Automação), Mercado Pago do ambiente ativo incompleto (Pagamentos), SMTP sem servidor
 * (E-mail) e dados da empresa incompletos (Geral). Login e Marketing são opcionais: nunca marcam.
 * Dado que não carregou (`null`) não marca nada, para não alarmar à toa.
 */
export function computeConfigAttention(input: {
  settings: PlatformSettingsView | null;
  legal: PlatformLegalInfo | null;
  whatsapp: PlatformWhatsappState | null;
}): ConfigAttention {
  const { settings, legal, whatsapp } = input;
  const billingWhatsappBroken = !!whatsapp && whatsapp.enabled && (!whatsapp.active || whatsapp.active.status === "DISCONNECTED");
  return {
    geral: legal ? !isLegalInfoComplete(legal) : false,
    whatsapp: (settings ? !(settings.evolutionApiUrl && settings.evolutionApiKeyMasked) : false) || billingWhatsappBroken,
    automacao: settings ? !(settings.n8nBaseUrl && settings.n8nApiKeyMasked) : false,
    pagamentos: settings ? !settings.mercadoPagoReady : false,
    email: settings ? !settings.smtpHost : false,
  };
}
