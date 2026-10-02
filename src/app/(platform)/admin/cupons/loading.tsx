import { navIconFor } from "@/components/shell/nav-items";
import { PageLoading } from "@/components/loading/page-loading";
import { FilterGridCardSkeleton, TableCardSkeleton } from "@/components/loading/parts";

export default function Loading() {
  return (
    <PageLoading icon={navIconFor("admin/cupons")} title="Cupons" description="Códigos de desconto para o cadastro e a tela Assinatura.">
      <FilterGridCardSkeleton fields={3} />
      <TableCardSkeleton columns={6} rows={5} />
    </PageLoading>
  );
}
