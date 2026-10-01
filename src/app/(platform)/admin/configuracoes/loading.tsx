import { navIconFor } from "@/components/shell/nav-items";
import { PageLoading } from "@/components/loading/page-loading";
import { SectionCardSkeleton } from "@/components/loading/parts";

export default function Loading() {
  return (
    <PageLoading
      icon={navIconFor("admin/configuracoes")}
      title="Configurações da plataforma"
      description="Evolution, n8n, e-mail transacional, Mercado Pago e o segredo da API interna. Tudo é cadastrado aqui, nunca em variável de ambiente."
    >
      <div className="flex flex-col gap-6">
        <SectionCardSkeleton bodyHeight="h-40" withFooter />
        <SectionCardSkeleton bodyHeight="h-40" withFooter />
        <SectionCardSkeleton bodyHeight="h-28" withFooter />
      </div>
    </PageLoading>
  );
}
