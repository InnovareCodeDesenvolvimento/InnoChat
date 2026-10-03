import { getPlatformSettingsAction } from "@/modules/platform/actions";
import { SmtpCard } from "@/components/admin/settings/smtp-card";
import { ConfigLoadError } from "../config-load-error";

export default async function ConfiguracoesEmailPage() {
  const settings = await getPlatformSettingsAction();
  if (!settings.ok) return <ConfigLoadError message={settings.error.message} />;
  return (
    <div className="flex flex-col gap-6">
      <SmtpCard initialSettings={settings.data} />
    </div>
  );
}
