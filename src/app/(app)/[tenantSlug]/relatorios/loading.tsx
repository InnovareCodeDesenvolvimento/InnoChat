import { navIconFor } from "@/components/shell/nav-items";
import { PageLoading } from "@/components/loading/page-loading";
import { TableCardSkeleton } from "@/components/loading/parts";

export default function Loading() {
  return (
    <PageLoading icon={navIconFor("relatorios")} title="Relatórios" description="Faturamento, ticket médio, faltas e comissões.">
      <TableCardSkeleton columns={5} rows={5} />
    </PageLoading>
  );
}
