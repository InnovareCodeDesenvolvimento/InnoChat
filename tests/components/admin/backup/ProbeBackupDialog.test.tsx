import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProbeResultSummary } from "@/components/admin/backup/probe-backup-dialog";
import { RemoteBackupsList } from "@/components/admin/backup/remote-backups-list";
import type { ListRemoteBackupsResult } from "@/modules/backup/restore-types";

const mockData: ListRemoteBackupsResult = {
  items: [
    {
      ref: "drive-file-123",
      name: "backup-innochat-2026-10-15.dump.enc",
      sizeBytes: 15728640,
      createdAt: "2026-10-15T03:00:00.000Z",
      keyFingerprint: "2f8a5d0b",
      source: "DRIVE",
    },
  ],
  page: 1,
  pageSize: 10,
  totalItems: 1,
  totalPages: 1,
};

describe("RemoteBackupsList > botão de teste de integridade", () => {
  it("renderiza o botão Testar integridade por linha, com rótulo acessível do arquivo", () => {
    const html = renderToStaticMarkup(createElement(RemoteBackupsList, { data: mockData }));

    expect(html).toContain("Testar integridade");
    expect(html).toContain('aria-label="Testar integridade do arquivo backup-innochat-2026-10-15.dump.enc"');
  });
});

describe("ProbeResultSummary (desfecho do teste de integridade)", () => {
  it("sucesso: mostra tabelas com dados, tamanho, impressão digital e data da cópia", () => {
    const html = renderToStaticMarkup(
      createElement(ProbeResultSummary, {
        result: {
          valid: true,
          fingerprint: "2f8a5d0b",
          tablesWithData: 42,
          uncompressedSizeBytes: 83886080,
          matchesCurrentSystemKey: true,
        },
        errorMessage: null,
        backupCreatedAt: "2026-10-02T03:00:00.000Z",
      }),
    );

    expect(html).toContain("A chave abriu o arquivo e ele está inteiro");
    expect(html).toContain("42");
    expect(html).toContain("80,0 MB");
    expect(html).toContain("2f8a5d0b");
    expect(html).toContain("É a mesma chave salva hoje no sistema");
    expect(html).toContain("02/10/2026");
  });

  it("sucesso com chave diferente da atual: avisa que não é a chave salva hoje", () => {
    const html = renderToStaticMarkup(
      createElement(ProbeResultSummary, {
        result: {
          valid: true,
          fingerprint: "aa11bb22",
          tablesWithData: 0,
          uncompressedSizeBytes: 1024,
          matchesCurrentSystemKey: false,
          warning: "O dump abriu corretamente, mas não contém nenhuma tabela com dados.",
        },
        errorMessage: null,
      }),
    );

    expect(html).toContain("É diferente da chave salva hoje no sistema");
    expect(html).toContain("não contém nenhuma tabela com dados");
  });

  it("chave errada: mostra o alerta de erro com a mensagem do backend, sem dados de sucesso", () => {
    const html = renderToStaticMarkup(
      createElement(ProbeResultSummary, {
        result: null,
        errorMessage:
          'A chave informada não descriptografa este backup. O arquivo foi cifrado com a chave de impressão digital 2f8a5d0b, e a chave utilizada possui impressão aa11bb22. Confira se é a chave certa.',
      }),
    );

    expect(html).toContain("O teste não conseguiu confirmar o backup");
    expect(html).toContain("Confira se é a chave certa");
    expect(html).not.toContain("A chave abriu o arquivo");
  });

  it("outro erro (ex.: arquivo truncado): mostra o alerta de erro genérico", () => {
    const html = renderToStaticMarkup(
      createElement(ProbeResultSummary, {
        result: null,
        errorMessage: "O arquivo de backup está truncado ou incompleto.",
      }),
    );

    expect(html).toContain("O teste não conseguiu confirmar o backup");
    expect(html).toContain("truncado ou incompleto");
  });

  it("sem resultado e sem erro (estado inicial): não renderiza nada", () => {
    const html = renderToStaticMarkup(createElement(ProbeResultSummary, { result: null, errorMessage: null }));
    expect(html).toBe("");
  });
});
