import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { EmptyState } from "@/components/ui/empty-state";
import { AlertTriangle } from "lucide-react";
import { listProfessionalsAction, listServicesAction } from "@/modules/agenda/catalog-actions";
import { listWhatsappInstancesAction } from "@/modules/whatsapp/actions";
import { OnboardingClient, type OnboardingProfessional, type OnboardingService } from "./onboarding-client";

export default async function OnboardingPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;

  const [servicesResult, professionalsResult, whatsappResult] = await Promise.all([
    listServicesAction(tenantSlug),
    listProfessionalsAction(tenantSlug),
    listWhatsappInstancesAction(tenantSlug),
  ]);

  if (!servicesResult.ok || !professionalsResult.ok) {
    return (
      <div>
        <PageHeader help="pagina.onboarding" icon={navIconFor("onboarding")} title="Primeiros passos" description="Configure sua empresa para começar a agendar." />
        <EmptyState
          icon={AlertTriangle}
          title="Não deu para carregar"
          description={!servicesResult.ok ? servicesResult.error.message : (professionalsResult as { ok: false; error: { message: string } }).error.message}
        />
      </div>
    );
  }

  const initialWhatsappConnected = whatsappResult.ok && whatsappResult.data.some((i) => i.status === "CONNECTED");

  return (
    <OnboardingClient
      tenantSlug={tenantSlug}
      initialServices={servicesResult.data as OnboardingService[]}
      initialProfessionals={professionalsResult.data as OnboardingProfessional[]}
      initialWhatsappConnected={initialWhatsappConnected}
    />
  );
}
