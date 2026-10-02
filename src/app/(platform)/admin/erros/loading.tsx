import { navIconFor } from "@/components/shell/nav-items";
import { PageLoading } from "@/components/loading/page-loading";
import { FilterGridCardSkeleton, TableCardSkeleton } from "@/components/loading/parts";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <PageLoading
      icon={navIconFor("admin/erros")}
      title="Erros"
      description="Os erros que o sistema registrou sozinho, juntando os que se repetem."
    >
      <div className="grid grid-cols-3 gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[84px] rounded-hero" />
        ))}
      </div>
      <div className="mt-4">
        <FilterGridCardSkeleton fields={2} />
        <TableCardSkeleton columns={5} rows={6} />
      </div>
    </PageLoading>
  );
}
