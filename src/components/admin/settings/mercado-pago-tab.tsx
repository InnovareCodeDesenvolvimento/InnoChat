"use client";

import { useRouter } from "next/navigation";
import { MercadoPagoPanel } from "@/components/admin/mercado-pago-panel";
import type { MercadoPagoConfig } from "@/components/admin/mercado-pago-types";

/** Mercado Pago na aba Pagamentos. Atualiza o ponto de atenção da aba (layout) a cada mudança. */
export function MercadoPagoTab({ initial, publicBaseUrl }: { initial: MercadoPagoConfig | null; publicBaseUrl: string | null }) {
  const router = useRouter();
  return <MercadoPagoPanel initial={initial} publicBaseUrl={publicBaseUrl} onConfigChange={() => router.refresh()} />;
}
