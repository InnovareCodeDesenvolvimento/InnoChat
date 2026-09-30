import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getPrisma } from "@/lib/db/prisma";
import { forTenant } from "@/lib/db/tenant-client";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { EquipeClient, type MemberRow } from "./equipe-client";

export default async function EquipePage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;

  const tenant = await getPrisma().tenant.findUnique({ where: { slug: tenantSlug }, select: { id: true } });
  if (!tenant) {
    notFound();
  }

  const session = await auth();

  const memberships = await forTenant(tenant.id).membership.findMany({
    orderBy: { createdAt: "asc" },
  });
  const users = await getPrisma().user.findMany({
    where: { id: { in: memberships.map((m) => m.userId) } },
    select: { id: true, email: true, emailVerifiedAt: true },
  });
  const userById = new Map(users.map((u) => [u.id, u]));

  const members: MemberRow[] = memberships.map((m) => {
    const user = userById.get(m.userId);
    return {
      id: m.id,
      email: user?.email ?? "—",
      role: m.role,
      verified: !!user?.emailVerifiedAt,
      isCurrentUser: m.userId === session?.user?.id,
    };
  });

  const currentMembership = memberships.find((m) => m.userId === session?.user?.id);
  const canInvite = currentMembership?.role === "OWNER";

  return (
    <div>
      <PageHeader help="pagina.equipe" icon={navIconFor("configuracoes")} title="Equipe" description="Quem tem acesso ao painel desta empresa." />
      <EquipeClient tenantSlug={tenantSlug} initialMembers={members} canInvite={canInvite} />
    </div>
  );
}
