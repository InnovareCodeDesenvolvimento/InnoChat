import { getPlatformSettingsAction } from "@/modules/platform/actions";
import { N8nCard } from "@/components/admin/settings/n8n-card";
import { BotN8nCard } from "@/components/admin/settings/bot-n8n-card";
import { InternalSecretCard } from "@/components/admin/settings/internal-secret-card";
import { BotFlowCard } from "@/components/admin/bot-flow-card";
import { ConfigLoadError } from "../config-load-error";

export default async function ConfiguracoesAutomacaoPage() {
  const settings = await getPlatformSettingsAction();
  if (!settings.ok) return <ConfigLoadError message={settings.error.message} />;
  return (
    <div className="flex flex-col gap-6">
      <N8nCard initialSettings={settings.data} />
      <BotN8nCard />
      <BotFlowCard />
      <InternalSecretCard initialConfigured={settings.data.internalApiSecretConfigured} />
    </div>
  );
}
