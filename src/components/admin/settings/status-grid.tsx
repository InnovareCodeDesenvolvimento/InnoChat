import type { PlatformSettingsView } from "@/modules/platform/service";
import { StatusCard } from "./config-parts";

/** Checklist da aba Geral: o que já está pronto para o bot e a cobrança funcionarem. */
export function StatusGrid({ settings, legalReady }: { settings: PlatformSettingsView; legalReady: boolean }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <StatusCard label="Evolution" ready={!!settings.evolutionApiUrl && !!settings.evolutionApiKeyMasked} />
      <StatusCard label="n8n" ready={!!settings.n8nBaseUrl && !!settings.n8nApiKeyMasked} />
      <StatusCard label="SMTP" ready={!!settings.smtpHost} />
      <StatusCard label="Mercado Pago" ready={settings.mercadoPagoReady} />
      <StatusCard label="Dados da empresa" ready={legalReady} />
    </div>
  );
}
