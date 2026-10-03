import { SectionCardSkeleton } from "@/components/loading/parts";

/** Esqueleto de qualquer aba: título e barra de abas já estão na tela (vêm do layout). */
export function ConfigTabLoading() {
  return (
    <div aria-busy="true" data-loading-page="" className="flex flex-col gap-6">
      <span role="status" className="sr-only">
        Carregando…
      </span>
      <SectionCardSkeleton bodyHeight="h-40" withFooter />
      <SectionCardSkeleton bodyHeight="h-28" withFooter />
    </div>
  );
}
