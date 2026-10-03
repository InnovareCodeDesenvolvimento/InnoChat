/**
 * Correções da revisão do Órion à Onda 1 (docs/seguranca/revisao-onda1-melhorias.md), contra Postgres real:
 * A-2 (2FA obrigatória também nas Server Actions), M-2 (monitor de erros: orçamentos por origem, retenção de grupos,
 * corpo com limite), M-3 (retenção do Pixel/CAPI), M-4 (cupom público genérico), M-6 (endereço do S3), SQL de fuso e
 * B-4 (ativar a 2FA derruba as outras sessões e avisa por e-mail).
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ userId: null as string | null }));
const refresh = vi.hoisted(() => ({ allowedDuringUpdate: [] as boolean[], userId: null as string | null }));
vi.mock("@/lib/auth", async () => {
  const { isSessionRefreshAllowed } = await import("@/modules/auth/session-refresh");
  return {
    auth: vi.fn(async () => (session.userId ? { user: { id: session.userId } } : null)),
    // `unstable_update` de mentira: registra se a renovação do cookie só é permitida DENTRO do escopo aberto pela rota.
    unstable_update: vi.fn(async () => {
      refresh.allowedDuringUpdate.push(isSessionRefreshAllowed(session.userId ?? ""));
      return null;
    }),
  };
});
vi.mock("@/lib/http/client-ip", () => ({ clientIp: async () => "203.0.113.90" }));
vi.mock("@/lib/email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
  const helpers = await import("./dunning.helpers");
  return { ...actual, sendMail: helpers.fakeSendMail(actual) };
});

const h = await import("./dunning.helpers");
const { requirePlatformAdmin, requireTenantMember } = await import("@/lib/auth/guards");
const twoFactorActions = await import("@/modules/two-factor/actions");
const { POST: postConfirm } = await import("@/app/api/two-factor/confirm/route");
const { isSessionRefreshAllowed } = await import("@/modules/auth/session-refresh");
const twoFactor = await import("@/modules/two-factor/service");
const { totpCode } = await import("@/modules/two-factor/totp");
const { hashPassword } = await import("@/modules/auth/service");
const { recordError, __resetCaptureThrottleForTests, BUDGETS } = await import("@/modules/error-monitor/capture");
const { purgeOldErrorEvents, ERROR_GROUP_RETENTION_DAYS } = await import("@/modules/error-monitor/service");
const { upsertErrorGroup } = await import("@/lib/db/error-queries");
const { __resetRateLimitsForTests } = await import("@/lib/rate-limit");
const { POST: postClientError } = await import("@/app/api/client-errors/route");
const { CLIENT_ERROR_MAX_BODY_BYTES } = await import("@/modules/error-monitor/client-report");
const { runMaintenanceTick, META_TRACKING_RETENTION_DAYS } = await import("@/modules/maintenance/tick");
const { previewSignupCouponAction } = await import("@/modules/billing/coupon-actions");
const coupons = await import("@/modules/billing/coupons");
const { saveBackupConfig, testBackupConnection } = await import("@/modules/backup/service");
const { claimCouponRedemption } = await import("@/lib/db/coupon-redeem");
const { claimDueBillingNotices } = await import("@/lib/db/billing-notice-queries");
const { queryContactsWithStats } = await import("@/lib/db/contact-queries");

const { prisma } = h;
const fixtures = h.newFixtures();
const run = randomUUID().slice(0, 8);
const PASSWORD = "senha-longa-de-teste-123";
const couponIds: string[] = [];

async function makeUser(label: string, extra: { isPlatformAdmin?: boolean; twoFactorRequired?: boolean; totp?: boolean } = {}) {
  const user = await prisma.user.create({
    data: {
      email: `it-sec1-${label}-${run}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
      emailVerifiedAt: new Date(),
      isPlatformAdmin: extra.isPlatformAdmin ?? false,
      twoFactorRequired: extra.twoFactorRequired ?? false,
      ...(extra.totp ? { totpSecretEnc: "enc:v1:x", totpEnabledAt: new Date() } : {}),
    },
  });
  fixtures.userIds.push(user.id);
  return user;
}

function confirmRequest(code: unknown) {
  return postConfirm(new Request("http://localhost/api/two-factor/confirm", { method: "POST", headers: { "Content-Type": "application/json", host: "localhost", origin: "http://localhost" }, body: JSON.stringify({ code }) }));
}

beforeEach(() => {
  refresh.allowedDuringUpdate.length = 0;
  h.resetMail();
  session.userId = null;
  __resetCaptureThrottleForTests();
  __resetRateLimitsForTests();
});

afterEach(async () => {
  await prisma.errorGroup.deleteMany({});
  await prisma.providerEvent.deleteMany({ where: { provider: { in: ["error-alert", "meta-signup", "meta-capi"] }, providerEventId: { startsWith: `it-sec1-${run}` } } });
});

afterAll(async () => {
  await prisma.coupon.deleteMany({ where: { id: { in: couponIds } } });
  await h.cleanup(fixtures);
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------
// A-2: 2FA obrigatória nos guards (Server Actions são endpoints POST; o layout só esconde a tela)
// ---------------------------------------------------------------------------------------------------------

describe("A-2: guards exigem a 2FA", () => {
  it("admin SEM 2FA é recusado por requirePlatformAdmin, com código próprio", async () => {
    const admin = await makeUser("admin-sem", { isPlatformAdmin: true });
    session.userId = admin.id;
    await expect(requirePlatformAdmin()).rejects.toMatchObject({ code: "TWO_FACTOR_SETUP_REQUIRED" });
  });

  it("action de admin recusa admin sem 2FA (Result de erro, nada executado)", async () => {
    const admin = await makeUser("admin-action", { isPlatformAdmin: true });
    session.userId = admin.id;
    const result = await twoFactorActions.listOtherAdminsTwoFactorAction();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TWO_FACTOR_SETUP_REQUIRED");
    const reset = await twoFactorActions.adminResetTwoFactorAction({ userId: admin.id });
    expect(reset.ok).toBe(false);
  });

  it("admin COM 2FA passa; quem não é admin continua FORBIDDEN", async () => {
    const admin = await makeUser("admin-com", { isPlatformAdmin: true, totp: true });
    session.userId = admin.id;
    await expect(requirePlatformAdmin()).resolves.toEqual({ id: admin.id });
    const plain = await makeUser("comum", { totp: true });
    session.userId = plain.id;
    await expect(requirePlatformAdmin()).rejects.toMatchObject({ code: "FORBIDDEN" });
    session.userId = null;
    await expect(requirePlatformAdmin()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("as actions de 2FA continuam liberadas para o admin sem 2FA (é por onde ele ativa)", async () => {
    const admin = await makeUser("admin-ativa", { isPlatformAdmin: true });
    session.userId = admin.id;
    const status = await twoFactorActions.getMyTwoFactorStatusAction();
    expect(status.ok && status.data.required).toBe(true);
    const begin = await twoFactorActions.beginTwoFactorSetupAction();
    expect(begin.ok).toBe(true);
    if (begin.ok) {
      const response = await confirmRequest(totpCode(begin.data.secret));
      expect(response.status).toBe(200);
    }
    await expect(requirePlatformAdmin()).resolves.toEqual({ id: admin.id });
  });

  it("usuário com twoFactorRequired e sem 2FA: requireTenantMember recusa; com 2FA ou sem exigência passa", async () => {
    const { tenant, user } = await h.makeTenant(fixtures, "guard2fa");
    await prisma.user.update({ where: { id: user.id }, data: { twoFactorRequired: true } });
    session.userId = user.id;
    await expect(requireTenantMember(tenant.slug)).rejects.toMatchObject({ code: "TWO_FACTOR_SETUP_REQUIRED" });

    await prisma.user.update({ where: { id: user.id }, data: { totpSecretEnc: "enc:v1:x", totpEnabledAt: new Date() } });
    await expect(requireTenantMember(tenant.slug)).resolves.toMatchObject({ tenant: { id: tenant.id } });

    const free = await h.makeTenant(fixtures, "guardlivre");
    session.userId = free.user.id;
    await expect(requireTenantMember(free.tenant.slug)).resolves.toMatchObject({ tenant: { id: free.tenant.id } });
  });
});

// ---------------------------------------------------------------------------------------------------------
// B-4: ativar a 2FA derruba as outras sessões e avisa por e-mail
// ---------------------------------------------------------------------------------------------------------

describe("B-4: ativar a 2FA", () => {
  it("incrementa sessionVersion e manda e-mail de aviso; desativar e redefinir também avisam", async () => {
    const user = await makeUser("aviso");
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion;
    const start = await twoFactor.beginTwoFactorSetup(user.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion).toBe(before);
    await twoFactor.confirmTwoFactorSetup(user.id, totpCode(start.secret));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion).toBe(before + 1);

    await vi.waitFor(() => expect(h.sentEmails.some((m) => m.to === user.email && /ativada/.test(m.subject))).toBe(true));
    const sent = h.sentEmails.find((m) => m.to === user.email)!;
    expect(sent.text).not.toContain(start.secret); // nada de segredo no aviso

    const admin = await makeUser("aviso-admin", { isPlatformAdmin: true, totp: true });
    await twoFactor.adminResetTwoFactor(admin.id, user.id);
    await vi.waitFor(() => expect(h.sentEmails.some((m) => m.to === user.email && /redefinida/.test(m.subject))).toBe(true));
  });

  it("a rota de confirmação ativa, renova o cookie só dentro do escopo permitido e recusa quem não tem sessão ou manda lixo", async () => {
    const user = await makeUser("rota");
    const start = await twoFactor.beginTwoFactorSetup(user.id);
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion;

    session.userId = null;
    expect((await confirmRequest(totpCode(start.secret))).status).toBe(401);

    session.userId = user.id;
    const bad = await confirmRequest("000000");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("TWO_FACTOR_CODE_INVALID");
    expect((await confirmRequest(12345)).status).toBe(400); // não é texto

    const response = await confirmRequest(totpCode(start.secret));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; data: { recoveryCodes: string[] } };
    expect(body.data.recoveryCodes).toHaveLength(10);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion).toBe(before + 1);
    expect(refresh.allowedDuringUpdate).toEqual([true]); // renovou o cookie, dentro do escopo
    expect(isSessionRefreshAllowed(user.id)).toBe(false); // e fora dele nunca vale

    const foreign = await postConfirm(new Request("http://localhost/api/two-factor/confirm", { method: "POST", headers: { host: "localhost", origin: "https://evil.example" }, body: "{}" }));
    expect(foreign.status).toBe(403);
  });

  it("a ativação não falha se o SMTP não está configurado", async () => {
    h.mailControl.mode = "not_configured";
    const user = await makeUser("sem-smtp");
    const start = await twoFactor.beginTwoFactorSetup(user.id);
    await expect(twoFactor.confirmTwoFactorSetup(user.id, totpCode(start.secret))).resolves.toHaveProperty("recoveryCodes");
  });
});

// ---------------------------------------------------------------------------------------------------------
// M-2: monitor de erros
// ---------------------------------------------------------------------------------------------------------

function letters(i: number): string {
  let out = "";
  let n = i;
  do {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  } while (n > 0);
  return out;
}

describe("M-2: monitor de erros", () => {
  it("o teto do NAVEGADOR não consome o orçamento do erro real do servidor", async () => {
    const t0 = new Date("2026-10-02T12:00:00Z");
    const results: string[] = [];
    for (let i = 0; i < BUDGETS.CLIENT.maxPerMinute + 20; i += 1) {
      const r = await recordError({ source: "CLIENT", message: `relato falso ${letters(i)}`, type: "Falso" }, t0);
      results.push(r.recorded ? "ok" : r.reason);
    }
    expect(results.filter((r) => r === "ok")).toHaveLength(BUDGETS.CLIENT.maxPerMinute);
    expect(results.at(-1)).toBe("THROTTLED");

    const real = await recordError({ source: "SERVER", message: "falha de verdade no servidor", type: "Error", route: "/api/real" }, t0);
    expect(real.recorded).toBe(true);
  });

  it("apaga grupo RESOLVED/IGNORED sem ocorrência há 90 dias; mantém OPEN antigo e RESOLVED recente", async () => {
    const now = new Date("2026-10-02T12:00:00Z");
    const old = new Date(now.getTime() - (ERROR_GROUP_RETENTION_DAYS + 5) * 86_400_000);
    const recent = new Date(now.getTime() - 10 * 86_400_000);
    const mk = async (label: string, seen: Date, status: "OPEN" | "RESOLVED" | "IGNORED") => {
      const g = await upsertErrorGroup({ fingerprint: `it-sec1-${run}-${label}`, message: label, type: "Error", source: "SERVER", route: null, version: null, now: seen });
      await prisma.errorGroup.update({ where: { id: g.id }, data: { status } });
      await prisma.errorEvent.create({ data: { groupId: g.id, occurredAt: seen } });
      return g.id;
    };
    const resolvedOld = await mk("resolved-old", old, "RESOLVED");
    const ignoredOld = await mk("ignored-old", old, "IGNORED");
    const openOld = await mk("open-old", old, "OPEN");
    const resolvedRecent = await mk("resolved-recent", recent, "RESOLVED");

    await purgeOldErrorEvents(now);

    const left = (await prisma.errorGroup.findMany({ select: { id: true } })).map((g) => g.id);
    expect(left).not.toContain(resolvedOld);
    expect(left).not.toContain(ignoredOld);
    expect(left).toContain(openOld);
    expect(left).toContain(resolvedRecent);
    expect(await prisma.errorEvent.count({ where: { groupId: { in: [resolvedOld, ignoredOld] } } })).toBe(0);
  });

  it("corpo grande sem Content-Length (chunked) é recusado com 413 sem ser lido por inteiro", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(4096));
        if (pulled > 5000) controller.close();
      },
    });
    const request = new Request("http://localhost/api/client-errors", {
      method: "POST",
      body,
      // @ts-expect-error `duplex` é exigido pelo Node para corpo em stream
      duplex: "half",
    });
    expect(request.headers.get("content-length")).toBeNull();
    const response = await postClientError(request);
    expect(response.status).toBe(413);
    expect(pulled * 4096).toBeLessThan(CLIENT_ERROR_MAX_BODY_BYTES * 4);
  });
});

// ---------------------------------------------------------------------------------------------------------
// M-3: retenção das linhas do Pixel/CAPI
// ---------------------------------------------------------------------------------------------------------

describe("M-3: retenção meta-signup/meta-capi", () => {
  it("a manutenção apaga linhas com mais de 180 dias e mantém as recentes", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - (META_TRACKING_RETENTION_DAYS + 5) * 86_400_000);
    const rows = [
      { provider: "meta-signup", providerEventId: `it-sec1-${run}-signup-old`, createdAt: old },
      { provider: "meta-capi", providerEventId: `it-sec1-${run}-capi-old`, createdAt: old },
      { provider: "meta-signup", providerEventId: `it-sec1-${run}-signup-new`, createdAt: now },
    ];
    for (const r of rows) await prisma.providerEvent.create({ data: { ...r, payload: {}, processedAt: r.createdAt } });

    await runMaintenanceTick(now);

    const left = (await prisma.providerEvent.findMany({ where: { providerEventId: { startsWith: `it-sec1-${run}` } } })).map((r) => r.providerEventId);
    expect(left).toEqual([`it-sec1-${run}-signup-new`]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// M-4: cupom público genérico
// ---------------------------------------------------------------------------------------------------------

describe("M-4: preview público de cupom", () => {
  it("qualquer motivo de recusa devolve a MESMA resposta (não confirma que o código existe)", async () => {
    const mk = async (over: Partial<Parameters<typeof coupons.createCoupon>[0]>) => {
      const c = await coupons.createCoupon({ code: `SEC${run}${letters(couponIds.length)}`.toUpperCase(), kind: "PERCENT", value: 10, duration: "ONCE", ...over }, null);
      couponIds.push(c.id);
      return c;
    };
    const expired = await mk({ validUntil: new Date(Date.now() - 86_400_000) });
    const future = await mk({ validFrom: new Date(Date.now() + 86_400_000 * 5) });
    const annualOnly = await mk({ appliesToCycles: ["ANNUAL"] });
    const exhausted = await mk({ maxRedemptions: 1 });
    await prisma.coupon.update({ where: { id: exhausted.id }, data: { redemptionsCount: 1 } });

    const answers = [] as string[];
    for (const code of [expired.code, future.code, exhausted.code, `NAOEXISTE${run}`.toUpperCase()]) {
      const r = await previewSignupCouponAction({ code, billingCycle: "MONTHLY" });
      expect(r.ok).toBe(false);
      if (!r.ok) answers.push(`${r.error.code}|${r.error.message}`);
    }
    // anual-só em ciclo mensal: também recusa, e com a mesma mensagem
    const wrongCycle = await previewSignupCouponAction({ code: annualOnly.code, billingCycle: "MONTHLY" });
    if (!wrongCycle.ok) answers.push(`${wrongCycle.error.code}|${wrongCycle.error.message}`);
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toContain("COUPON_INVALID");
  });

  it("o motivo detalhado segue existindo para quem é logado (previewCoupon direto, usado pela tela do dono e pelo Admin)", async () => {
    const c = await coupons.createCoupon({ code: `SEC${run}DET`.toUpperCase(), kind: "PERCENT", value: 10, duration: "ONCE", validUntil: new Date(Date.now() - 86_400_000) }, null);
    couponIds.push(c.id);
    const plan = await prisma.plan.findFirstOrThrow({ where: { active: true } });
    await expect(coupons.previewCoupon({ code: c.code, planId: plan.id, cycle: "MONTHLY" })).rejects.toMatchObject({ code: "COUPON_EXPIRED" });
  });
});

// ---------------------------------------------------------------------------------------------------------
// M-6: endereço do S3
// ---------------------------------------------------------------------------------------------------------

describe("M-6: endereço do bucket", () => {
  it("salvar recusa http, IP privado/loopback/link-local e nome interno", async () => {
    for (const endpoint of ["http://s3.example.com", "https://127.0.0.1", "https://169.254.169.254", "https://10.0.0.5:9000", "https://minio", "file:///etc/passwd"]) {
      await expect(saveBackupConfig({ s3Endpoint: endpoint }, "adm")).rejects.toMatchObject({ code: "BACKUP_S3_ENDPOINT_INVALID" });
    }
  });

  it("testar a conexão com endereço que não resolve devolve mensagem amigável, sem eco do SDK", async () => {
    await prisma.backupConfig.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    await saveBackupConfig({ destination: "S3", s3Endpoint: "https://s3.backup-teste.invalid", s3Bucket: "b", s3AccessKey: "AK", s3SecretKey: "segredo-do-bucket-123" }, "adm");
    try {
      await testBackupConnection();
      throw new Error("deveria falhar");
    } catch (error) {
      const e = error as { code?: string; message: string };
      expect(e.code).toBe("BACKUP_CONFIG");
      expect(e.message).toMatch(/Endereço do bucket recusado/);
      expect(e.message).not.toMatch(/ENOTFOUND|getaddrinfo/);
    } finally {
      await prisma.backupConfig.update({ where: { id: 1 }, data: { destination: null, s3Endpoint: null, s3Bucket: null, s3AccessKey: null, s3SecretKeyEnc: null } });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// SQL de fuso: com a sessão do Postgres fora de UTC, as consultas cruas não deslocam a hora
// ---------------------------------------------------------------------------------------------------------

async function withSessionTimezone<T>(tz: string, fn: () => Promise<T>): Promise<T> {
  const [{ db }] = await prisma.$queryRawUnsafe<{ db: string }[]>("SELECT current_database() AS db");
  // `ALTER DATABASE ... SET` vale para as sessões NOVAS: desconectar força o pool a abrir sessões já no fuso novo.
  await prisma.$executeRawUnsafe(`ALTER DATABASE "${db}" SET timezone TO '${tz}'`);
  await prisma.$disconnect();
  try {
    const [{ timezone }] = await prisma.$queryRawUnsafe<{ timezone: string }[]>("SELECT current_setting('timezone') AS timezone");
    expect(timezone).toBe(tz);
    return await fn();
  } finally {
    await prisma.$executeRawUnsafe(`ALTER DATABASE "${db}" RESET timezone`);
    await prisma.$disconnect();
  }
}

describe("SQL cru com a sessão em America/Sao_Paulo", () => {
  const NOW = new Date("2026-06-15T15:00:00.000Z");
  const hour = 3_600_000;

  it("error-queries: grava o instante exato (sem deslocar 3 h)", async () => {
    await withSessionTimezone("America/Sao_Paulo", async () => {
      const g = await upsertErrorGroup({ fingerprint: `it-sec1-${run}-tz`, message: "tz", type: "Error", source: "SERVER", route: null, version: null, now: NOW });
      const row = await prisma.errorGroup.findUniqueOrThrow({ where: { id: g.id } });
      expect(row.firstSeenAt.toISOString()).toBe(NOW.toISOString());
      expect(row.lastSeenAt.toISOString()).toBe(NOW.toISOString());
    });
  });

  it("coupon-redeem: a janela de validade é respeitada ao milissegundo de hora (±1 h)", async () => {
    await withSessionTimezone("America/Sao_Paulo", async () => {
      const mk = async (n: string, validFrom: Date | null, validUntil: Date | null) => {
        const c = await coupons.createCoupon({ code: `SEC${run}${n}`.toUpperCase(), kind: "PERCENT", value: 10, duration: "ONCE", validFrom, validUntil }, null);
        couponIds.push(c.id);
        return c;
      };
      const inside = await mk("TZIN", new Date(NOW.getTime() - hour), new Date(NOW.getTime() + hour));
      const expired = await mk("TZEXP", null, new Date(NOW.getTime() - hour));
      const notYet = await mk("TZFUT", new Date(NOW.getTime() + hour), null);
      expect(await claimCouponRedemption(prisma, inside.id, NOW)).toBe(true);
      expect(await claimCouponRedemption(prisma, expired.id, NOW)).toBe(false);
      expect(await claimCouponRedemption(prisma, notYet.id, NOW)).toBe(false);
      const row = await prisma.coupon.findUniqueOrThrow({ where: { id: inside.id } });
      expect(row.updatedAt.toISOString()).toBe(NOW.toISOString());
    });
  });

  it("billing-notice-queries: só reivindica o que já venceu (notBefore ±1 h) e grava updatedAt exato", async () => {
    const t = await h.makeTenant(fixtures, "tz-notice");
    const sub = await h.makePayingSubscription(fixtures, t.tenant.id, "tz-notice", { currentPeriodEnd: h.at("2026-12-20T10:00:00Z") });
    const mk = (notBefore: Date) =>
      prisma.billingNotice.create({
        data: { tenantId: t.tenant.id, subscriptionId: sub.id, step: "DUE_D1", channel: "EMAIL", cycleKey: `it-tz-${randomUUID()}`, status: "PENDING", notBefore, expiresAt: new Date(NOW.getTime() + 86_400_000), nextAttemptAt: notBefore },
      });
    const due = await mk(new Date(NOW.getTime() - hour));
    const future = await mk(new Date(NOW.getTime() + hour));
    await withSessionTimezone("America/Sao_Paulo", async () => {
      const claimed = await claimDueBillingNotices({ now: NOW, limit: 50, stuckBefore: new Date(NOW.getTime() - 30 * 60_000), maxAttempts: 5, onlyIds: [due.id, future.id] });
      expect(claimed.map((n) => n.id)).toEqual([due.id]);
      const row = await prisma.billingNotice.findUniqueOrThrow({ where: { id: due.id } });
      expect(row.updatedAt.toISOString()).toBe(NOW.toISOString());
    });
  });

  it("contact-queries: filtro 'bot pausado' compara com a hora certa (±1 h)", async () => {
    const t = await h.makeTenant(fixtures, "tz-contacts");
    const mk = (label: string, until: Date) =>
      prisma.contact.create({ data: { tenantId: t.tenant.id, waJid: `5584${randomUUID().slice(0, 8).replace(/\D/g, "1")}@s.whatsapp.net`, name: label, botPausedUntil: until } });
    const paused = await mk("pausado", new Date(NOW.getTime() + hour));
    await mk("liberado", new Date(NOW.getTime() - hour));
    await withSessionTimezone("America/Sao_Paulo", async () => {
      const { rows } = await queryContactsWithStats({ tenantId: t.tenant.id, filter: "botPaused", offset: 0, limit: 50, now: NOW });
      expect(rows.map((r) => r.id)).toEqual([paused.id]);
    });
  });
});
