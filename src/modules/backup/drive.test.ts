import { describe, expect, it } from "vitest";
import { ACTION_BY_CATEGORY, classifyDriveFailure, dumpsQuery, DriveFailure, normalizeFolderId, parseServiceAccountKey } from "./drive";

describe("classifyDriveFailure: cada causa pede uma ação diferente", () => {
  it("cota vence permissão (também chega como 403)", () => {
    expect(classifyDriveFailure(403, JSON.stringify({ error: { message: "Service Accounts do not have storage quota.", errors: [{ reason: "storageQuotaExceeded" }] } }))).toBe("quota");
  });
  it("401 e invalid_grant do token viram credencial", () => {
    expect(classifyDriveFailure(401, "{}")).toBe("credential");
    expect(classifyDriveFailure(400, JSON.stringify({ error: "invalid_grant", error_description: "Invalid JWT Signature." }))).toBe("credential");
  });
  it("404 e 403 de permissão viram pasta", () => {
    expect(classifyDriveFailure(404, JSON.stringify({ error: { message: "File not found: abc", errors: [{ reason: "notFound" }] } }))).toBe("folder");
    expect(classifyDriveFailure(403, JSON.stringify({ error: { message: "The user does not have sufficient permissions", errors: [{ reason: "insufficientFilePermissions" }] } }))).toBe("folder");
  });
  it("429 e 5xx viram rede; o resto é desconhecido", () => {
    expect(classifyDriveFailure(429, "{}")).toBe("network");
    expect(classifyDriveFailure(503, "texto solto")).toBe("network");
    expect(classifyDriveFailure(418, "{}")).toBe("unknown");
  });
  it("toda causa tem a frase do que fazer, sem travessão", () => {
    for (const text of Object.values(ACTION_BY_CATEGORY)) {
      expect(text.length).toBeGreaterThan(30);
      expect(text).not.toContain("—");
    }
    expect(new DriveFailure("Falhou.", "folder").message).toContain(ACTION_BY_CATEGORY.folder);
  });
});

describe("normalizeFolderId: aceita o link colado do navegador", () => {
  it("extrai o id de várias formas", () => {
    expect(normalizeFolderId("https://drive.google.com/drive/folders/1AbC_dEf-GhIjKlMn?usp=sharing")).toBe("1AbC_dEf-GhIjKlMn");
    expect(normalizeFolderId("https://drive.google.com/open?id=1AbC_dEf-GhIjKlMn")).toBe("1AbC_dEf-GhIjKlMn");
    expect(normalizeFolderId("  1AbC_dEf-GhIjKlMn  ")).toBe("1AbC_dEf-GhIjKlMn");
  });
  it("recusa o que não é id", () => {
    expect(normalizeFolderId("minha pasta de backup")).toBeNull();
    expect(normalizeFolderId("")).toBeNull();
    expect(normalizeFolderId(null)).toBeNull();
  });
  it("a consulta de dumps só pega arquivos do nosso formato dentro da pasta", () => {
    expect(dumpsQuery("PASTA")).toContain("'PASTA' in parents");
    expect(dumpsQuery("PASTA")).toContain("trashed = false");
    expect(dumpsQuery("PASTA")).toContain("backup-");
  });
});

describe("parseServiceAccountKey: nunca ecoa a chave", () => {
  const key = {
    type: "service_account",
    client_email: "bkp@proj.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n",
    project_id: "proj",
  };
  it("lê e desescapa o \\n da chave", () => {
    const cred = parseServiceAccountKey(JSON.stringify(key));
    expect(cred.clientEmail).toBe("bkp@proj.iam.gserviceaccount.com");
    expect(cred.privateKey).toContain("\nABC\n");
    expect(cred.projectId).toBe("proj");
  });
  it("recusa arquivo quebrado e de outro tipo sem vazar pedaço da chave", () => {
    for (const bad of ['{ "private_key": "SEGREDO-123"', JSON.stringify({ type: "authorized_user", private_key: "SEGREDO-123" })]) {
      let thrown: unknown;
      try {
        parseServiceAccountKey(bad);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(DriveFailure);
      expect((thrown as Error).message).not.toContain("SEGREDO-123");
    }
  });
});
