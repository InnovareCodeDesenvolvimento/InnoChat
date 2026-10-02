import { Building2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { EmptyState } from "@/components/ui/empty-state";
import { listCompaniesAction } from "@/modules/billing/admin-actions";
import { AdminEmpresasClient } from "./admin-empresas-client";

export default async function AdminEmpresasPage() {
  const result = await listCompaniesAction();

  if (!result.ok) {
    return (
      <div>
        <PageHeader icon={navIconFor("admin/empresas")} title="Empresas" description="Status da assinatura, limites e trial de cada empresa." />
        <EmptyState icon={Building2} title="Não deu para carregar as empresas" description={result.error.message} />
      </div>
    );
  }

  const items = result.data.items.map((item) => ({
    ...item,
    trialEndsAt: item.trialEndsAt ? new Date(item.trialEndsAt).toISOString() : null,
    currentPeriodEnd: new Date(item.currentPeriodEnd).toISOString(),
  }));

  return (
    <AdminEmpresasClient
      initialItems={items}
      initialPaging={{ page: result.data.page, pageSize: result.data.pageSize, totalItems: result.data.totalItems, totalPages: result.data.totalPages }}
    />
  );
}
