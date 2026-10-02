import { navIconFor } from "@/components/shell/nav-items";
import { PageLoading } from "@/components/loading/page-loading";
import { FilterGridCardSkeleton, TableCardSkeleton } from "@/components/loading/parts";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <PageLoading
      icon={navIconFor("admin/envios")}
      title="Envios de cobrança"
      description="Cada aviso mandado às empresas: para quem foi, por qual canal e se chegou."
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[84px] rounded-hero" />
        ))}
      </div>
      <div className="mt-4">
        <FilterGridCardSkeleton fields={6} />
        <TableCardSkeleton columns={6} rows={6} />
      </div>
    </PageLoading>
  );
}
