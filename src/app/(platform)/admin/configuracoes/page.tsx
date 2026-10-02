import { Settings } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { EmptyState } from "@/components/ui/empty-state";
import { getGoogleAuthConfigAction, getMercadoPagoConfigAction, getPlatformLegalInfoAction, getPlatformSalesWhatsappAction, getPlatformSettingsAction } from "@/modules/platform/actions";
import { getMetaConfigAction } from "@/modules/meta/actions";
import { getPlatformWhatsappAction } from "@/modules/platform/platform-whatsapp-actions";
import { AdminConfiguracoesClient } from "./admin-configuracoes-client";

export default async function AdminConfiguracoesPage() {
  const [settingsResult, legalResult, salesResult, mpResult, googleResult, platformWhatsappResult, metaResult] = await Promise.all([
    getPlatformSettingsAction(),
    getPlatformLegalInfoAction(),
    getPlatformSalesWhatsappAction(),
    getMercadoPagoConfigAction(),
    getGoogleAuthConfigAction(),
    getPlatformWhatsappAction(),
    getMetaConfigAction(),
  ]);

  if (!settingsResult.ok) {
    return (
      <div>
        <PageHeader icon={navIconFor("admin/configuracoes")} title="Configurações da plataforma" description="Evolution, n8n, e-mail, Mercado Pago e segredo da API interna." />
        <EmptyState icon={Settings} title="Não deu para carregar" description={settingsResult.error.message} />
      </div>
    );
  }

  return (
    <AdminConfiguracoesClient
      initialSettings={settingsResult.data}
      initialLegal={legalResult.ok ? legalResult.data : null}
      initialSalesWhatsapp={salesResult.ok ? salesResult.data : null}
      initialMercadoPago={mpResult.ok ? mpResult.data : null}
      initialGoogle={googleResult.ok ? googleResult.data : null}
      initialPlatformWhatsapp={platformWhatsappResult.ok ? platformWhatsappResult.data : null}
      initialMeta={metaResult.ok ? metaResult.data : null}
    />
  );
}
