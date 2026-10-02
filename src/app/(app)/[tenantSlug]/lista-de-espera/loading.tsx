import { navIconFor } from "@/components/shell/nav-items";
import { PageLoading } from "@/components/loading/page-loading";
import { CountChipSkeleton, FilterGridCardSkeleton, TableCardSkeleton } from "@/components/loading/parts";

export default function Loading() {
  return (
    <PageLoading
      icon={navIconFor("lista-de-espera")}
      title="Lista de espera"
      description="Quem está esperando um horário, por dia e profissional."
      action="w-48"
    >
      <CountChipSkeleton />
      <FilterGridCardSkeleton fields={3} />
      <TableCardSkeleton columns={5} rows={6} />
    </PageLoading>
  );
}
