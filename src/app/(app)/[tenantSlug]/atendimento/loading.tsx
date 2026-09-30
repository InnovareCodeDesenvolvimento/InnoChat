import { navIconFor } from "@/components/shell/nav-items";
import { PageLoading } from "@/components/loading/page-loading";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <PageLoading
      icon={navIconFor("atendimento")}
      title="Atendimento"
      description="Responda pelo painel os clientes que pediram atendente."
    >
      <div className="flex h-[calc(100dvh-10rem)] min-h-[28rem] overflow-hidden rounded-hero border border-border bg-surface shadow-card md:h-[calc(100dvh-17rem)] md:min-h-[32rem]">
        <div className="flex w-full flex-col md:w-[22rem] md:shrink-0 md:border-r md:border-border">
          <div className="flex gap-2 border-b border-border p-2">
            <Skeleton className="h-11 flex-1" />
            <Skeleton className="h-11 flex-1" />
            <Skeleton className="h-11 flex-1" />
          </div>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-3 border-b border-border px-3 py-3">
              <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Skeleton className="h-3.5 w-2/5" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            </div>
          ))}
        </div>
        <div className="hidden flex-1 md:block" />
      </div>
    </PageLoading>
  );
}
