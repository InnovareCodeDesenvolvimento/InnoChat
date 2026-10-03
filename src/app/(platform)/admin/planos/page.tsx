import { Layers } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { EmptyState } from "@/components/ui/empty-state";
import { listPlansAction, planCycleUsageAction } from "@/modules/billing/admin-actions";
import { AdminPlanosClient, type PlanRow } from "./admin-planos-client";

export default async function AdminPlanosPage() {
  const [result, usage] = await Promise.all([listPlansAction(), planCycleUsageAction()]);

  if (!result.ok) {
    return (
      <div>
        <PageHeader icon={navIconFor("admin/planos")} title="Planos" description="Limites, preço e ativação de cada plano." />
        <EmptyState icon={Layers} title="Não deu para carregar os planos" description={result.error.message} />
      </div>
    );
  }

  return <AdminPlanosClient initialPlans={result.data as PlanRow[]} cycleUsage={usage.ok ? usage.data : {}} />;
}
