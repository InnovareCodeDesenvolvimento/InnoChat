import { getMercadoPagoConfigAction, getPlatformSettingsAction } from "@/modules/platform/actions";
import { MercadoPagoTab } from "@/components/admin/settings/mercado-pago-tab";
import { ConfigLoadError } from "../config-load-error";

export default async function ConfiguracoesPagamentosPage() {
  const [settings, mp] = await Promise.all([getPlatformSettingsAction(), getMercadoPagoConfigAction()]);
  if (!settings.ok) return <ConfigLoadError message={settings.error.message} />;
  return (
    <div className="flex flex-col gap-6">
      <MercadoPagoTab initial={mp.ok ? mp.data : null} publicBaseUrl={settings.data.publicBaseUrl} />
    </div>
  );
}
