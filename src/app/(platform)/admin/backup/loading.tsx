import { navIconFor } from "@/components/shell/nav-items";
import { PageLoading } from "@/components/loading/page-loading";
import { TableCardSkeleton } from "@/components/loading/parts";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <PageLoading icon={navIconFor("admin/backup")} title="Backup do banco" description="Cópia diária do banco fora do servidor, com aviso se atrasar.">
      <Skeleton className="h-[120px] rounded-hero" />
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-[260px] rounded-hero" />
        <Skeleton className="h-[260px] rounded-hero" />
      </div>
      <div className="mt-4">
        <TableCardSkeleton columns={5} rows={5} />
      </div>
    </PageLoading>
  );
}
