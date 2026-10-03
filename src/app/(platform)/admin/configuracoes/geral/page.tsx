import { getPlatformLegalInfoAction, getPlatformSalesWhatsappAction, getPlatformSettingsAction } from "@/modules/platform/actions";
import { StatusGrid } from "@/components/admin/settings/status-grid";
import { UrlsCard } from "@/components/admin/settings/urls-card";
import { LegalCard } from "@/components/admin/settings/legal-card";
import { isLegalInfoComplete } from "../config-attention";
import { ConfigLoadError } from "../config-load-error";

export default async function ConfiguracoesGeralPage() {
  const [settings, legal, sales] = await Promise.all([getPlatformSettingsAction(), getPlatformLegalInfoAction(), getPlatformSalesWhatsappAction()]);
  if (!settings.ok) return <ConfigLoadError message={settings.error.message} />;
  return (
    <div className="flex flex-col gap-6">
      <StatusGrid settings={settings.data} legalReady={legal.ok ? isLegalInfoComplete(legal.data) : false} />
      <UrlsCard settings={settings.data} />
      <LegalCard initialLegal={legal.ok ? legal.data : null} initialSalesWhatsapp={sales.ok ? sales.data : null} />
    </div>
  );
}
