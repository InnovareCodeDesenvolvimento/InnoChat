import { navIconFor } from "@/components/shell/nav-items";
import { PageLoading } from "@/components/loading/page-loading";
import { TableCardSkeleton } from "@/components/loading/parts";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <PageLoading icon={navIconFor("admin/empresas")} title="Cobrança da empresa" description="Plano, faturas e tudo o que aconteceu na cobrança.">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[132px] rounded-hero" />
        ))}
      </div>
      <div className="mt-6 flex flex-col gap-6">
        <TableCardSkeleton columns={5} rows={3} />
        <Skeleton className="h-64 rounded-hero" />
      </div>
    </PageLoading>
  );
}
