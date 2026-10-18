import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RemoteBackupsList } from "@/components/admin/backup/remote-backups-list";
import type { ListRemoteBackupsResult } from "@/modules/backup/restore-types";

describe("RemoteBackupsList", () => {
  const mockBackups: ListRemoteBackupsResult = {
    items: [
      {
        ref: "drive-file-123",
        name: "backup-innochat-2026-10-15.dump.enc",
        sizeBytes: 15728640, // ~15 MB
        createdAt: "2026-10-15T03:00:00.000Z",
        keyFingerprint: "2f8a5d0b",
        source: "DRIVE",
      },
      {
        ref: "drive-file-456",
        name: "backup-innochat-2026-10-14.dump.enc",
        sizeBytes: 1048576, // 1 MB
        createdAt: "2026-10-14T03:00:00.000Z",
        keyFingerprint: null,
        source: "S3",
      },
      {
        ref: "drive-file-789",
        name: "backup-innochat-2026-10-13.dump.enc",
        sizeBytes: 512, // 512 B
        createdAt: "2026-10-13T03:00:00.000Z",
        keyFingerprint: "a1b2c3d4",
        source: "DRIVE",
      },
    ],
    page: 1,
    pageSize: 10,
    totalItems: 3,
    totalPages: 1,
  };

  it("renderiza a tabela de backups com as colunas e badges corretos", () => {
    const html = renderToStaticMarkup(
      createElement(RemoteBackupsList, { data: mockBackups })
    );

    expect(html).toContain("Cópias no Armazenamento Remoto");
    expect(html).toContain("backup-innochat-2026-10-15.dump.enc");
    expect(html).toContain("15,0 MB");
    expect(html).toContain("2f8a5d0b");
    expect(html).toContain("Google Drive");
    expect(html).toContain("Bucket S3");
    expect(html).toContain("Disponível");
  });

  it("renderiza links de download apontando para o endpoint com atributo download", () => {
    const html = renderToStaticMarkup(
      createElement(RemoteBackupsList, { data: mockBackups })
    );

    expect(html).toContain('href="/api/admin/backup/download?ref=drive-file-123"');
    expect(html).toContain('download="backup-innochat-2026-10-15.dump.enc"');
    expect(html).toContain("Baixar");
  });

  it("exibe empty state acolhedor quando não houver cópias no destino", () => {
    const emptyData: ListRemoteBackupsResult = {
      items: [],
      page: 1,
      pageSize: 10,
      totalItems: 0,
      totalPages: 0,
    };

    const html = renderToStaticMarkup(
      createElement(RemoteBackupsList, { data: emptyData, destinationName: "Google Drive" })
    );

    expect(html).toContain("Nenhum backup remoto ainda");
    expect(html).toContain("Ainda não há cópias salvas no Google Drive");
  });

  it("exibe aviso quando o destino não estiver configurado", () => {
    const emptyData: ListRemoteBackupsResult = {
      items: [],
      page: 1,
      pageSize: 10,
      totalItems: 0,
      totalPages: 0,
    };

    const html = renderToStaticMarkup(
      createElement(RemoteBackupsList, { data: emptyData, destinationReady: false })
    );

    expect(html).toContain("Destino ainda não configurado");
    expect(html).toContain("Configure o destino acima");
  });

  it("renderiza controles de paginação quando houver múltiplas páginas", () => {
    const pagedData: ListRemoteBackupsResult = {
      items: mockBackups.items,
      page: 1,
      pageSize: 10,
      totalItems: 35,
      totalPages: 4,
    };

    const html = renderToStaticMarkup(
      createElement(RemoteBackupsList, { data: pagedData })
    );

    expect(html).toContain("Próxima");
    expect(html).toContain("Anterior");
    expect(html).toContain("Mostrando");
  });
});
