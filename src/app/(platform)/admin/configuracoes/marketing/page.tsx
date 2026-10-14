import { getMetaConfigAction } from "@/modules/meta/actions";
import { MetaPixelCard } from "@/components/admin/meta-pixel-card";
import { getRescueSettingsAction } from "@/modules/rescue/admin-actions";
import { RescueKillSwitchCard } from "@/components/admin/rescue/rescue-kill-switch-card";

export default async function ConfiguracoesMarketingPage() {
  const [meta, rescueSettings] = await Promise.all([
    getMetaConfigAction(),
    getRescueSettingsAction(),
  ]);

  const rescueEnabled = rescueSettings.ok ? rescueSettings.data.rescueWhatsappEnabled : false;

  return (
    <div className="flex flex-col gap-6">
      <div id="resgate">
        <RescueKillSwitchCard initialEnabled={rescueEnabled} />
      </div>
      <div id="pixel">
        <MetaPixelCard initial={meta.ok ? meta.data : null} />
      </div>
    </div>
  );
}
