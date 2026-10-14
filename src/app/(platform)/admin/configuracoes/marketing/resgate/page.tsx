import { getRescueSettingsAction } from "@/modules/rescue/admin-actions";
import { RescueKillSwitchCard } from "@/components/admin/rescue/rescue-kill-switch-card";
import { PageHeader } from "@/components/ui/page-header";
import { Power } from "lucide-react";

export default async function AdminConfiguracoesMarketingResgatePage() {
  const rescueSettings = await getRescueSettingsAction();
  const rescueEnabled = rescueSettings.ok ? rescueSettings.data.rescueWhatsappEnabled : false;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Power}
        title="Kill Switch do Resgate"
        description="Controle global da régua de resgate de leads pós-cadastro."
        help="admin.resgateKillSwitch"
      />
      <RescueKillSwitchCard initialEnabled={rescueEnabled} />
    </div>
  );
}
