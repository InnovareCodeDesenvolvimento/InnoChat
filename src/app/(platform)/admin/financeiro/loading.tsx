import { navIconFor } from "@/components/shell/nav-items";
import { PageLoading } from "@/components/loading/page-loading";
import { FilterGridCardSkeleton } from "@/components/loading/parts";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <PageLoading
      icon={navIconFor("admin/financeiro")}
      title="Financeiro"
      description="Receita, atrasos e cancelamentos das empresas, no horário de Brasília."
    >
      <div className="flex flex-col gap-6">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[176px] rounded-hero" />
          ))}
        </div>
        <div className="grid gap-3 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[260px] rounded-hero" />
          ))}
        </div>
        <FilterGridCardSkeleton fields={3} />
      </div>
    </PageLoading>
  );
}
