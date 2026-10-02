import { navIconFor } from "@/components/shell/nav-items";
import { PageLoading } from "@/components/loading/page-loading";
import { FilterGridCardSkeleton, TableCardSkeleton } from "@/components/loading/parts";

export default function Loading() {
  return (
    <PageLoading icon={navIconFor("configuracoes")} title="Histórico de alterações" description="Quem da equipe mudou o quê no painel, e quando.">
      <FilterGridCardSkeleton fields={4} />
      <TableCardSkeleton columns={4} rows={6} />
    </PageLoading>
  );
}
