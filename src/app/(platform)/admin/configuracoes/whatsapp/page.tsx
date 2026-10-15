import { getPlatformSettingsAction } from "@/modules/platform/actions";
import { getPlatformWhatsappAction } from "@/modules/platform/platform-whatsapp-actions";
import { EvolutionCard } from "@/components/admin/settings/evolution-card";
import { PlatformWhatsappCard } from "@/components/admin/platform-whatsapp-card";
import { UserCheck } from "lucide-react";
import Link from "next/link";
import { ConfigLoadError } from "../config-load-error";

export default async function ConfiguracoesWhatsappPage() {
  const [settings, billingWhatsapp, rescueWhatsapp] = await Promise.all([
    getPlatformSettingsAction(),
    getPlatformWhatsappAction("BILLING"),
    getPlatformWhatsappAction("RESCUE"),
  ]);
  if (!settings.ok) return <ConfigLoadError message={settings.error.message} />;
  return (
    <div className="flex flex-col gap-6">
      <EvolutionCard initialSettings={settings.data} />
      <PlatformWhatsappCard initialState={billingWhatsapp.ok ? billingWhatsapp.data : null} />
      <PlatformWhatsappCard
        purpose="RESCUE"
        title="WhatsApp de resgate"
        description="O número que envia mensagens automáticas de acolhimento a quem veio pelo Meta Ads e ainda não acessou o painel da empresa."
        cardId="whatsapp-resgate"
        helpKey="admin.whatsappResgate"
        labelDefault="Resgate"
        enabledSwitchLabel="Mandar mensagens de resgate pelo WhatsApp"
        connectButtonLabel="Conectar WhatsApp de resgate"
        disabledNotice="Desligado: nenhuma mensagem de acolhimento é enviada aos novos cadastros."
        emptyNotice="Nenhum número conectado para o resgate. Os novos cadastros não recebem mensagens de acolhimento."
        icon={UserCheck}
        emptyStateBox={
          <div className="rounded-card border border-border bg-bg p-4 text-sm text-text-secondary">
            Ligue a chave geral de resgate nas{" "}
            <Link
              href="/admin/configuracoes/marketing#resgate"
              className="text-primary underline hover:text-primary-hover font-medium"
            >
              Configurações de Marketing
            </Link>{" "}
            e conecte o chip aqui para começar.
          </div>
        }
        initialState={rescueWhatsapp.ok ? rescueWhatsapp.data : null}
      />
    </div>
  );
}
