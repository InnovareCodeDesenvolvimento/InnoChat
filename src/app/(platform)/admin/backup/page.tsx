import { DatabaseBackup } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { navIconFor } from "@/components/shell/nav-items";
import { parsePageSize, parsePositiveInt } from "@/components/lib/pagination";
import { getBackupPanelAction } from "@/modules/backup/actions";
import { BackupClient } from "./backup-client";

type SearchParams = { pagina?: string; porPagina?: string; google?: string; motivo?: string };

export default async function AdminBackupPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const result = await getBackupPanelAction({ page: parsePositiveInt(sp.pagina, 1), pageSize: parsePageSize(sp.porPagina) });

  if (!result.ok) {
    return (
      <div>
        <PageHeader
          icon={navIconFor("admin/backup")}
          title="Backup do banco"
          description="Cópia diária do banco fora do servidor, com aviso se atrasar."
          help="pagina.adminBackup"
        />
        <EmptyState icon={DatabaseBackup} title="Não deu para carregar o backup" description={result.error.message} />
      </div>
    );
  }

  const google = sp.google === "conectado" ? { ok: true as const } : sp.google === "erro" ? { ok: false as const, reason: (sp.motivo ?? "desconhecido").slice(0, 40) } : null;
  return <BackupClient data={result.data} google={google} />;
}
