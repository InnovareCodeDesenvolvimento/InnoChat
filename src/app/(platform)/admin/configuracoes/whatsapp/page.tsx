import { getPlatformSettingsAction } from "@/modules/platform/actions";
import { getPlatformWhatsappAction } from "@/modules/platform/platform-whatsapp-actions";
import { EvolutionCard } from "@/components/admin/settings/evolution-card";
import { PlatformWhatsappCard } from "@/components/admin/platform-whatsapp-card";
import { ConfigLoadError } from "../config-load-error";

export default async function ConfiguracoesWhatsappPage() {
  const [settings, whatsapp] = await Promise.all([getPlatformSettingsAction(), getPlatformWhatsappAction()]);
  if (!settings.ok) return <ConfigLoadError message={settings.error.message} />;
  return (
    <div className="flex flex-col gap-6">
      <EvolutionCard initialSettings={settings.data} />
      <PlatformWhatsappCard initialState={whatsapp.ok ? whatsapp.data : null} />
    </div>
  );
}
