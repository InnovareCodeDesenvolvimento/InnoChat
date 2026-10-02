import { navIconFor } from "@/components/shell/nav-items";
import { PageLoading } from "@/components/loading/page-loading";
import { FilterGridCardSkeleton, TableCardSkeleton } from "@/components/loading/parts";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <PageLoading
      icon={navIconFor("admin/cobranca")}
      title="Cobranças"
      description="Faturas de todas as empresas, totais do mês e inadimplência."
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[88px] rounded-hero" />
        ))}
      </div>
      <div className="mt-6">
        <FilterGridCardSkeleton fields={4} />
        <TableCardSkeleton columns={6} rows={5} />
      </div>
    </PageLoading>
  );
}
