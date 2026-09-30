import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { Card, CardContent } from "@/components/ui/card";
import { getPrisma } from "@/lib/db/prisma";
import { AparenciaForm } from "./aparencia-form";

export default async function AparenciaPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const tenant = await getPrisma().tenant.findUnique({
    where: { slug: tenantSlug },
    select: { theme: true },
  });

  if (!tenant) {
    notFound();
  }

  return (
    <div>
      <PageHeader help="pagina.aparencia" icon={navIconFor("configuracoes")}
        title="Aparência"
        description="O tema escolhido vale para toda a equipe desta empresa."
      />
      <Card className="rounded-hero">
        <CardContent>
          <AparenciaForm tenantSlug={tenantSlug} currentTheme={tenant.theme} />
        </CardContent>
      </Card>
    </div>
  );
}
