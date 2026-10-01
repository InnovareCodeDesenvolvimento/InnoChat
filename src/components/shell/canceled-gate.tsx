"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CreditCard } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Assinatura CANCELADA (Termos §9): "o Painel mostra apenas a tela de Assinatura, para
 * reativação". Qualquer outra rota do painel mostra só este aviso, sem renderizar a página. A
 * escrita já é barrada no servidor (`assertTenantCanWrite`) e o bot, no claim — isto é a camada
 * visual da mesma regra.
 */
export function CanceledGate({ tenantSlug, canceled, children }: { tenantSlug: string; canceled: boolean; children: React.ReactNode }) {
  const pathname = usePathname();
  const billingPath = `/${tenantSlug}/assinatura`;
  const onBilling = pathname === billingPath || !!pathname?.startsWith(`${billingPath}/`);
  if (!canceled || onBilling) return <>{children}</>;
  return (
    <Card className="mx-auto max-w-xl rounded-hero" data-testid="painel-cancelado">
      <CardHeader>
        <CardTitle>Assinatura cancelada</CardTitle>
        <CardDescription>Para voltar a usar o painel, reative a assinatura na tela de Assinatura.</CardDescription>
      </CardHeader>
      <CardContent>
        <Link href={billingPath} className="inline-flex items-center gap-2 font-medium text-primary hover:underline">
          <CreditCard className="h-4 w-4" aria-hidden="true" />
          Ir para Assinatura
        </Link>
      </CardContent>
    </Card>
  );
}
