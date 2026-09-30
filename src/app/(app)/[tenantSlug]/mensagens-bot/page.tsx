import { Bot } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { EmptyState } from "@/components/ui/empty-state";
import { listBotTextsAction } from "@/modules/bot-texts/bot-text-actions";
import { MensagensBotClient, type BotTextRow } from "./mensagens-bot-client";

export default async function MensagensBotPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const result = await listBotTextsAction(tenantSlug);

  if (!result.ok) {
    return (
      <div>
        <PageHeader icon={navIconFor("mensagens-bot")} title="Mensagens do bot" description="Edite os textos que o bot envia no WhatsApp." />
        <EmptyState icon={Bot} title="Não deu para carregar as mensagens" description={result.error.message} />
      </div>
    );
  }

  return <MensagensBotClient tenantSlug={tenantSlug} initialTexts={result.data.items as BotTextRow[]} />;
}
