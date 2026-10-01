import { navIconFor } from "@/components/shell/nav-items";
import { PageLoading } from "@/components/loading/page-loading";
import { CountChipSkeleton, FilterGridCardSkeleton, TableCardSkeleton } from "@/components/loading/parts";

export default function Loading() {
  return (
    <PageLoading
      icon={navIconFor("agendamentos")}
      title="Agendamentos"
      description="Filtre por período, profissional e situação."
      action="w-48"
    >
      <CountChipSkeleton />
      <FilterGridCardSkeleton />
      <TableCardSkeleton columns={5} rows={6} />
    </PageLoading>
  );
}
