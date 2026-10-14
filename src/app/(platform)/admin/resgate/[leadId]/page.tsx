import { notFound } from "next/navigation";
import { UserCheck } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { getRescueLeadDetailAction } from "@/modules/rescue/admin-actions";
import { RescueDetailClient } from "@/components/admin/rescue/rescue-detail-client";

type Params = { leadId: string };

export default async function AdminRescueLeadDetailPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { leadId } = await params;
  const result = await getRescueLeadDetailAction(leadId);

  if (!result.ok) {
    if (result.error.code === "NOT_FOUND") {
      notFound();
    }
    return (
      <div>
        <PageHeader
          icon={UserCheck}
          title="Detalhes do lead"
          description="Acompanhe o histórico e as ações do resgate deste lead."
          help="admin.resgateDetalhe"
        />
        <EmptyState icon={UserCheck} title="Não deu para carregar o lead" description={result.error.message} />
      </div>
    );
  }

  return <RescueDetailClient lead={result.data} />;
}
