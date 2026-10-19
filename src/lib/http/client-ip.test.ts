import { describe, expect, it } from "vitest";

// `client-ip.ts` importa `next/headers`; só a função pura interessa aqui.
import { vi } from "vitest";
vi.mock("next/headers", () => ({ headers: vi.fn() }));
const { pickClientIp, isFromCloudflareEdge, extractEdgeHop, TRUSTED_PROXY_HOPS } = await import("./client-ip");

describe("pickClientIp (1 proxy confiável = Traefik, que ACRESCENTA ao fim do X-Forwarded-For)", () => {
  it("usa o ÚLTIMO valor, não o primeiro (o primeiro é forjável pelo cliente)", () => {
    expect(TRUSTED_PROXY_HOPS).toBe(1);
    expect(pickClientIp("6.6.6.6, 203.0.113.9", null)).toBe("203.0.113.9");
    expect(pickClientIp("1.1.1.1, 2.2.2.2, 203.0.113.9", null)).toBe("203.0.113.9");
  });

  it("valor único é o do proxy", () => {
    expect(pickClientIp("203.0.113.9", null)).toBe("203.0.113.9");
  });

  it("2 proxies confiáveis: pega o penúltimo", () => {
    expect(pickClientIp("6.6.6.6, 203.0.113.9, 10.0.0.2", null, 2)).toBe("203.0.113.9");
  });

  it("aceita IPv6", () => {
    expect(pickClientIp("2001:db8::1", null)).toBe("2001:db8::1");
  });

  it("lixo no XFF cai para X-Real-IP válido, e sem nada vira unknown", () => {
    expect(pickClientIp("nao-e-ip", "198.51.100.7")).toBe("198.51.100.7");
    expect(pickClientIp("<script>", "tambem-nao")).toBe("unknown");
    expect(pickClientIp(null, null)).toBe("unknown");
    expect(pickClientIp("", "")).toBe("unknown");
  });
});

describe("isFromCloudflareEdge — faixas oficiais da Cloudflare", () => {
  it("reconhece IPv4 dentro das faixas publicadas", () => {
    expect(isFromCloudflareEdge("103.21.244.5")).toBe(true);
    expect(isFromCloudflareEdge("172.64.0.1")).toBe(true);
    expect(isFromCloudflareEdge("104.16.123.45")).toBe(true);
  });

  it("reconhece IPv6 dentro das faixas publicadas", () => {
    expect(isFromCloudflareEdge("2606:4700::1")).toBe(true);
    expect(isFromCloudflareEdge("2606:4700:1234::abcd")).toBe(true);
  });

  it("rejeita IP comum (não é da Cloudflare)", () => {
    expect(isFromCloudflareEdge("8.8.8.8")).toBe(false);
    expect(isFromCloudflareEdge("203.0.113.9")).toBe(false);
    expect(isFromCloudflareEdge("2001:db8::1")).toBe(false);
    expect(isFromCloudflareEdge("nao-e-ip")).toBe(false);
  });

  it("aceita IPv4-mapped em IPv6 (::ffff:a.b.c.d)", () => {
    expect(isFromCloudflareEdge("::ffff:172.64.0.1")).toBe(true);
    expect(isFromCloudflareEdge("::ffff:8.8.8.8")).toBe(false);
  });

  it("descarta a zona de escopo (%eth0) antes de checar a faixa", () => {
    expect(isFromCloudflareEdge("2606:4700::1%eth0")).toBe(true);
    expect(isFromCloudflareEdge("2001:db8::1%eth0")).toBe(false);
  });
});

describe("extractEdgeHop — hop que de fato conectou no proxy confiável (reusado por public-url.ts)", () => {
  it("usa o último valor do XFF quando presente", () => {
    expect(extractEdgeHop("6.6.6.6, 203.0.113.9", null)).toBe("203.0.113.9");
  });

  it("sem XFF, cai para X-Real-IP", () => {
    expect(extractEdgeHop(null, "198.51.100.7")).toBe("198.51.100.7");
  });

  it("sem nenhum dos dois, devolve null", () => {
    expect(extractEdgeHop(null, null)).toBeNull();
    expect(extractEdgeHop("", "")).toBeNull();
  });
});

describe("pickClientIp + CF-Connecting-IP (Cloudflare na frente do Traefik)", () => {
  it("Traefik substitui o XFF pelo IP da borda da Cloudflare (mesmo valor para todo visitante) — usa CF-Connecting-IP em vez disso", () => {
    // Cenário real (bug 2026-10-19): sem a Cloudflare em `trustedIPs`, o Traefik descarta o XFF
    // que a Cloudflare mandou e grava só o IP de quem conectou nele — a própria borda da Cloudflare.
    const cfEdgeIp = "172.64.0.1";
    expect(pickClientIp(cfEdgeIp, null, 1, "198.51.100.11")).toBe("198.51.100.11");
    expect(pickClientIp(cfEdgeIp, null, 1, "198.51.100.22")).toBe("198.51.100.22");
    // Sem a Cloudflare, dois visitantes diferentes não ficariam mais com o mesmo "IP" de rate limit.
  });

  it("ignora CF-Connecting-IP forjado quando a requisição NÃO passou pela Cloudflare (hop não é da borda dela)", () => {
    expect(pickClientIp("203.0.113.9", null, 1, "9.9.9.9")).toBe("203.0.113.9");
  });

  it("sem header CF-Connecting-IP, comportamento de sempre (hops no XFF) mesmo com hop de borda da Cloudflare", () => {
    expect(pickClientIp("172.64.0.1", null, 1, null)).toBe("172.64.0.1");
  });

  it("CF-Connecting-IP inválido (não é IP) é ignorado mesmo com hop da Cloudflare", () => {
    expect(pickClientIp("172.64.0.1", null, 1, "<script>")).toBe("172.64.0.1");
  });

  it("2 proxies confiáveis (hops=2) continua funcionando sem Cloudflare", () => {
    expect(pickClientIp("6.6.6.6, 203.0.113.9, 10.0.0.2", null, 2, null)).toBe("203.0.113.9");
  });
});
