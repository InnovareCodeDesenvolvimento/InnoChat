import { navIconFor } from "@/components/shell/nav-items";
import { PageLoading } from "@/components/loading/page-loading";
import { FilterGridCardSkeleton, TableCardSkeleton } from "@/components/loading/parts";

export default function Loading() {
  return (
    <PageLoading icon={navIconFor("admin/auditoria")} title="Auditoria" description="Quem mudou o quê, em todas as empresas e na plataforma.">
      <FilterGridCardSkeleton fields={5} />
      <TableCardSkeleton columns={4} rows={6} />
    </PageLoading>
  );
}
