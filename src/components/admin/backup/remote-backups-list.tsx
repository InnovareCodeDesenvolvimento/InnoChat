"use client";

import { useState, useTransition } from "react";
import { Download, Cloud, HardDrive, Shield, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/ui/pagination";
import { formatTimeLabel } from "@/components/lib/format-date";
import { formatBytes } from "@/components/lib/format-bytes";
import { formatDateBR } from "@/modules/billing/format";
import { Panel, RowShell, StatusPill, PanelEmptyState } from "./admin-ui";
import { ProbeBackupDialog } from "./probe-backup-dialog";
import type { ListRemoteBackupsResult, RemoteBackupItem } from "@/modules/backup/restore-types";

const TZ = "America/Sao_Paulo";

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return `${formatDateBR(d, TZ)} às ${formatTimeLabel(d, TZ)}`;
}

export type RemoteBackupsListProps = {
  data: ListRemoteBackupsResult;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  destinationReady?: boolean;
  destinationName?: string;
  isPending?: boolean;
};

export function RemoteBackupsList({
  data,
  onPageChange,
  onPageSizeChange,
  destinationReady = true,
  destinationName = "armazenamento remoto",
  isPending: externalPending = false,
}: RemoteBackupsListProps) {
  const [internalPending, startTransition] = useTransition();
  const isPending = externalPending || internalPending;
  const [probeTarget, setProbeTarget] = useState<RemoteBackupItem | null>(null);

  function handlePage(page: number) {
    if (onPageChange) {
      startTransition(() => {
        onPageChange(page);
      });
    }
  }

  function handlePageSize(size: number) {
    if (onPageSizeChange) {
      startTransition(() => {
        onPageSizeChange(size);
      });
    }
  }

  return (
    <Panel
      className="mt-6"
      title="Cópias no Armazenamento Remoto"
      description="Backups gravados no seu disco virtual ou nuvem. Você pode baixar qualquer cópia para conferir ou guardar fora do sistema."
      help="backup.copiasRemotas"
      bodyClassName="p-0"
    >
      {!destinationReady ? (
        <PanelEmptyState
          icon={Cloud}
          title="Destino ainda não configurado"
          description="Configure o destino acima (Google Drive ou S3) e gere um backup para ver as cópias remotas aqui."
        />
      ) : data.totalItems === 0 ? (
        <PanelEmptyState
          icon={HardDrive}
          title="Nenhum backup remoto ainda"
          description={`Ainda não há cópias salvas no ${destinationName}. O próximo backup agendado ou manual aparecerá listado aqui.`}
        />
      ) : (
        <div className={isPending ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={isPending || undefined}>
          <div className="divide-y divide-border" role="list" aria-label="Cópias no armazenamento remoto">
            {data.items.map((backup: RemoteBackupItem) => {
              const downloadHref = `/api/admin/backup/download?ref=${encodeURIComponent(backup.ref)}`;
              return (
                <RowShell
                  key={backup.ref}
                  actions={
                    <>
                      <Button variant="secondary" icon={ShieldCheck} aria-label={`Testar integridade do arquivo ${backup.name}`} onClick={() => setProbeTarget(backup)}>
                        Testar integridade
                      </Button>
                      <Button asChild variant="secondary" aria-label={`Baixar arquivo ${backup.name}`}>
                        <a href={downloadHref} download={backup.name} className="inline-flex items-center gap-1.5">
                          <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
                          <span>Baixar</span>
                        </a>
                      </Button>
                    </>
                  }
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill tone="info">{backup.source === "DRIVE" ? "Google Drive" : "Bucket S3"}</StatusPill>
                      <StatusPill tone="success">Disponível</StatusPill>
                      {backup.keyFingerprint ? (
                        <span className="inline-flex items-center gap-1 font-mono text-xs text-text-secondary">
                          <Shield className="h-3 w-3" aria-hidden="true" />
                          {backup.keyFingerprint}
                        </span>
                      ) : (
                        <span className="text-xs text-text-secondary">Sem chave</span>
                      )}
                    </div>
                    <p className="mt-1 truncate font-mono text-xs font-medium text-text" title={backup.name}>
                      {backup.name}
                    </p>
                    <p className="mt-0.5 text-xs tabular-nums text-text-secondary">
                      {formatWhen(backup.createdAt)} · {formatBytes(backup.sizeBytes)}
                    </p>
                  </div>
                </RowShell>
              );
            })}
          </div>
          <div className="border-t border-border p-4">
            <Pagination
              label="Paginação das cópias remotas de backup"
              page={data.page}
              pageSize={data.pageSize}
              totalItems={data.totalItems}
              totalPages={data.totalPages}
              isPending={isPending}
              onPageChange={handlePage}
              onPageSizeChange={handlePageSize}
            />
          </div>
        </div>
      )}
      <ProbeBackupDialog
        backup={probeTarget}
        open={probeTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setProbeTarget(null);
        }}
      />
    </Panel>
  );
}
