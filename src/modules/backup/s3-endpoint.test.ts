import { describe, expect, it } from "vitest";
import { checkS3EndpointResolved, checkS3EndpointShape, isPrivateOrReservedIp } from "./s3-endpoint";

describe("isPrivateOrReservedIp", () => {
  it.each([
    "10.0.0.5", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.10", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "::1", "::", "fe80::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3", "[::1]",
  ])("%s é recusado", (ip) => {
    expect(isPrivateOrReservedIp(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "172.32.0.1", "172.15.0.1", "100.63.0.1", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("%s é público", (ip) => {
    expect(isPrivateOrReservedIp(ip)).toBe(false);
  });
});

describe("checkS3EndpointShape", () => {
  it("aceita https com nome público", () => {
    expect(checkS3EndpointShape("https://abc.r2.cloudflarestorage.com").ok).toBe(true);
    expect(checkS3EndpointShape("https://s3.us-east-1.amazonaws.com").ok).toBe(true);
  });

  it.each([
    "http://s3.example.com",
    "file:///etc/passwd",
    "ftp://s3.example.com",
    "https://user:senha@s3.example.com",
    "https://localhost",
    "https://minio",
    "https://bucket.internal",
    "https://db.local",
    "https://127.0.0.1:9000",
    "https://169.254.169.254",
    "https://[::1]",
    "https://10.0.0.8",
    "isto nao e url",
  ])("recusa %s", (raw) => {
    expect(checkS3EndpointShape(raw).ok).toBe(false);
  });
});

describe("checkS3EndpointResolved", () => {
  it("recusa nome público que RESOLVE para IP interno (DNS na hora)", async () => {
    const msg = await checkS3EndpointResolved("https://s3.example.com", async () => ["93.184.216.34", "10.0.0.7"]);
    expect(msg).toMatch(/rede interna/);
  });

  it("recusa metadados de nuvem vindos de DNS", async () => {
    expect(await checkS3EndpointResolved("https://s3.example.com", async () => ["169.254.169.254"])).not.toBeNull();
  });

  it("aceita quando todos os endereços são públicos", async () => {
    expect(await checkS3EndpointResolved("https://s3.example.com", async () => ["93.184.216.34", "2606:4700:4700::1111"])).toBeNull();
  });

  it("DNS que falha ou volta vazio vira mensagem amigável", async () => {
    expect(await checkS3EndpointResolved("https://s3.example.com", async () => { throw new Error("ENOTFOUND"); })).toMatch(/encontrar esse endereço/);
    expect(await checkS3EndpointResolved("https://s3.example.com", async () => [])).toMatch(/encontrar esse endereço/);
  });

  it("não consulta DNS quando a forma já é inválida", async () => {
    let called = false;
    expect(await checkS3EndpointResolved("http://s3.example.com", async () => { called = true; return []; })).toMatch(/https/);
    expect(called).toBe(false);
  });
});
