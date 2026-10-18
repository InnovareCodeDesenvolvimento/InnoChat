"use client";

import { useState, useTransition } from "react";
import { Download, Cloud, HardDrive, Shield, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from "@/components/ui/table";
import { formatTimeLabel } from "@/components/lib/format-date";
import { formatBytes } from "@/components/lib/format-bytes";
import { formatDateBR } from "@/modules/billing/format";
import { ProbeBackupDialog } from "./probe-backup-dialog";
import type { ListRemoteBackupsResult, RemoteBackupItem } from "@/modules/backup/restore-types";

const TZ = "America/Sao_Paulo";

function RemoteWhen({ iso }: { iso: string }) {
  const d = new Date(iso);
  return (
    <>
      <span className="block font-medium tabular-nums text-text">{formatDateBR(d, TZ)}</span>
      <span className="block text-xs tabular-nums text-text-secondary">{formatTimeLabel(d, TZ)}</span>
    </>
  );
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
    <Card className="mt-6">
      <CardHeader help="backup.copiasRemotas">
        <CardTitle>Cópias no Armazenamento Remoto</CardTitle>
        <CardDescription>
          Backups gravados no seu disco virtual ou nuvem. Você pode baixar qualquer cópia para conferir ou guardar fora do sistema.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {!destinationReady ? (
          <div className="p-5">
            <EmptyState
              icon={Cloud}
              title="Destino ainda não configurado"
              description="Configure o destino acima (Google Drive ou S3) e gere um backup para ver as cópias remotas aqui."
            />
          </div>
        ) : data.totalItems === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={HardDrive}
              title="Nenhum backup remoto ainda"
              description={`Ainda não há cópias salvas no ${destinationName}. O próximo backup agendado ou manual aparecerá listado aqui.`}
            />
          </div>
        ) : (
          <div className={isPending ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={isPending || undefined}>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeadCell>Nome do arquivo</TableHeadCell>
                  <TableHeadCell>Data de criação</TableHeadCell>
                  <TableHeadCell>Tamanho</TableHeadCell>
                  <TableHeadCell>Chave</TableHeadCell>
                  <TableHeadCell>Fonte</TableHeadCell>
                  <TableHeadCell>Situação</TableHeadCell>
                  <TableHeadCell className="text-right">Ação</TableHeadCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.items.map((backup: RemoteBackupItem) => {
                  const downloadHref = `/api/admin/backup/download?ref=${encodeURIComponent(backup.ref)}`;
                  return (
                    <TableRow key={backup.ref}>
                      <TableCell className="font-mono text-xs font-medium text-text">
                        <span className="block max-w-xs truncate sm:max-w-md" title={backup.name}>
                          {backup.name}
                        </span>
                      </TableCell>
                      <TableCell>
                        <RemoteWhen iso={backup.createdAt} />
                      </TableCell>
                      <TableCell className="tabular-nums">{formatBytes(backup.sizeBytes)}</TableCell>
                      <TableCell>
                        {backup.keyFingerprint ? (
                          <span className="inline-flex items-center gap-1 font-mono text-xs text-text">
                            <Shield className="h-3 w-3 text-text-secondary" aria-hidden="true" />
                            {backup.keyFingerprint}
                          </span>
                        ) : (
                          <span className="text-xs text-text-secondary">Sem chave</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="neutral">{backup.source === "DRIVE" ? "Google Drive" : "Bucket S3"}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="success">Disponível</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="secondary"
                            icon={ShieldCheck}
                            aria-label={`Testar integridade do arquivo ${backup.name}`}
                            onClick={() => setProbeTarget(backup)}
                          >
                            Testar integridade
                          </Button>
                          <Button
                            asChild
                            variant="secondary"
                            aria-label={`Baixar arquivo ${backup.name}`}
                          >
                            <a href={downloadHref} download={backup.name} className="inline-flex items-center gap-1.5">
                              <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
                              <span>Baixar</span>
                            </a>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <div className="p-4">
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
      </CardContent>
      <ProbeBackupDialog
        backup={probeTarget}
        open={probeTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setProbeTarget(null);
        }}
      />
    </Card>
  );
}
