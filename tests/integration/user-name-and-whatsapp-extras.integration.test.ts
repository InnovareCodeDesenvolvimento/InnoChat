/**
 * Nome do usuário (cadastro, convite, perfil) e dados extras da tela WhatsApp, contra Postgres
 * real. `requireSessionUser`/`requireTenantMember` são trocados (não há sessão Auth.js fora do
 * Next); as actions são chamadas de verdade.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";
import type { TenantContext } from "@/lib/auth/guards";

const auth: { userId: string | null; ctx: TenantContext | null } = { userId: null, ctx: null };
vi.mock("@/lib/auth/guards", () => ({
  requireSessionUser: async () => {
    const { DomainError } = await import("@/lib/errors");
    if (!auth.userId) throw new DomainError("UNAUTHENTICATED", "É necessário estar autenticado.");
    return { id: auth.userId };
  },
  requireTenantMember: async (slug: string) => {
    const { DomainError } = await import("@/lib/errors");
    if (!auth.ctx || auth.ctx.tenant.slug !== slug) throw new DomainError("NOT_FOUND", "Empresa não encontrada.");
    return auth.ctx;
  },
}));

let ipCounter = 0;
vi.mock("@/lib/http/client-ip", () => ({ clientIp: async () => `10.0.0.${++ipCounter}` }));

const sentEmails: { to: string; subject: string; html?: string; text?: string }[] = [];
vi.mock("@/lib/email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
  return {
    ...actual,
    sendMail: vi.fn(async (input: { to: string; subject: string; html?: string; text?: string }) => {
      sentEmails.push(input);
      return { sent: true };
    }),
  };
});

const { signUpAction, acceptInviteAction } = await import("@/modules/signup/actions");
const { inviteTeamMember } = await import("@/modules/signup/service");
const { getMyAccountAction, updateMyAccountAction } = await import("@/modules/auth/account-actions");
const { getWhatsappPageExtrasAction } = await import("@/modules/whatsapp/actions");
const { TERMS_VERSION } = await import("@/lib/legal");
const { getAppointmentTimeline } = await import("@/modules/notifications/service");

const prisma = getPrisma();
const tenantIds: string[] = [];
const userIds: string[] = [];
const planIds: string[] = [];

beforeEach(() => {
  auth.userId = null;
  auth.ctx = null;
  sentEmails.length = 0;
});

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.plan.deleteMany({ where: { id: { in: planIds } } });
  await prisma.$disconnect();
});

function signupPayload(overrides: Record<string, unknown> = {}) {
  const slug = `it-name-${randomUUID().slice(0, 8)}`;
  return {
    companyName: "Estúdio Nome",
    slug,
    email: `${slug}@example.com`,
    password: "senha-forte-123",
    document: "529.982.247-25",
    phone: "(84) 99999-8888", // WhatsApp é obrigatório no cadastro
    termsVersion: TERMS_VERSION,
    acceptedTerms: true,
    name: "Maria Souza",
    ...overrides,
  };
}

async function trackSignup(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) userIds.push(user.id);
  const membership = user ? await prisma.membership.findFirst({ where: { userId: user.id } }) : null;
  if (membership) tenantIds.push(membership.tenantId);
  return user;
}

describe("cadastro público — nome obrigatório", () => {
  it("grava User.name (trim) e cria a conta", async () => {
    const payload = signupPayload({ name: "  Maria Souza  " });
    const result = await signUpAction(payload);
    const user = await trackSignup(payload.email);
    expect(result.ok).toBe(true);
    expect(user?.name).toBe("Maria Souza");
  });

  it.each([
    ["ausente", undefined],
    ["vazio", ""],
    ["só espaços", "   "],
    ["1 letra", "A"],
    ["81 caracteres", "x".repeat(81)],
  ])("nome %s é rejeitado com INVALID_PAYLOAD e NADA é criado", async (_label, name) => {
    const payload: Record<string, unknown> = signupPayload({ name });
    if (name === undefined) delete payload.name;
    const result = await signUpAction(payload);
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_PAYLOAD" } });
    expect(await prisma.user.findUnique({ where: { email: payload.email as string } })).toBeNull();
  });

  it("aceita 2 e 80 caracteres (limites)", async () => {
    for (const name of ["Jo", "x".repeat(80)]) {
      const payload = signupPayload({ name });
      const result = await signUpAction(payload);
      const user = await trackSignup(payload.email);
      expect(result.ok).toBe(true);
      expect(user?.name).toBe(name);
    }
  });

  it("alias legado ownerName ainda é aceito (formulário em cache durante a transição)", async () => {
    const payload: Record<string, unknown> = signupPayload();
    delete payload.name;
    const result = await signUpAction({ ...payload, ownerName: "Dona Antiga" });
    const user = await trackSignup(payload.email as string);
    expect(result.ok).toBe(true);
    expect(user?.name).toBe("Dona Antiga");
  });
});

describe("aceitar convite — pede nome", () => {
  async function invite(label: string) {
    const tenant = await prisma.tenant.create({ data: { slug: `it-inv-${label}-${randomUUID().slice(0, 8)}`, name: `Inv ${label}`, timezone: "UTC" } });
    tenantIds.push(tenant.id);
    const email = `inv-${randomUUID().slice(0, 8)}@example.com`;
    await inviteTeamMember({ tenantId: tenant.id, tenantName: tenant.name, email, role: "STAFF" });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    userIds.push(user.id);
    const mail = sentEmails.find((m) => m.to === email)!;
    const token = /token=([\w-]+)/.exec(`${mail.html ?? ""} ${mail.text ?? ""}`)![1]!;
    return { user, token };
  }

  it("com nome válido: grava name (trim), define a senha e devolve a empresa", async () => {
    const { user, token } = await invite("ok");
    const result = await acceptInviteAction({ token, password: "senha-nova-123", name: "  Carlos Dias " });
    expect(result.ok).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).name).toBe("Carlos Dias");
  });

  it("sem nome (ou inválido): INVALID_PAYLOAD e o convite NÃO é consumido", async () => {
    const { user, token } = await invite("bad");
    for (const name of [undefined, "", "A", "x".repeat(81)]) {
      const r = await acceptInviteAction({ token, password: "senha-nova-123", ...(name === undefined ? {} : { name }) });
      expect(r).toMatchObject({ ok: false, error: { code: "INVALID_PAYLOAD" } });
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).name).toBeNull();
    expect(await acceptInviteAction({ token, password: "senha-nova-123", name: "Carlos" })).toMatchObject({ ok: true });
  });
});

describe("perfil — getMyAccountAction / updateMyAccountAction", () => {
  async function makeUser(name: string | null) {
    const user = await prisma.user.create({ data: { email: `acc-${randomUUID().slice(0, 8)}@example.com`, passwordHash: "x", name } });
    userIds.push(user.id);
    return user;
  }

  it("lê { name, email } do próprio usuário (name null quando não cadastrado)", async () => {
    const a = await makeUser(null);
    auth.userId = a.id;
    expect(await getMyAccountAction()).toEqual({ ok: true, data: { name: null, email: a.email } });
  });

  it("atualiza SÓ o próprio nome (trim) — o outro usuário não é afetado", async () => {
    const a = await makeUser("Ana Antiga");
    const b = await makeUser("Bruno Intocado");
    auth.userId = a.id;
    expect(await updateMyAccountAction({ name: "  Ana Nova  " })).toEqual({ ok: true, data: { name: "Ana Nova", email: a.email } });
    // Tentar injetar o id de outro usuário no payload não tem efeito: o id vem da sessão.
    await updateMyAccountAction({ name: "Ana Nova 2", userId: b.id, id: b.id });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.id } })).name).toBe("Bruno Intocado");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: a.id } })).name).toBe("Ana Nova 2");
  });

  it.each(["", " ", "A", "x".repeat(81)])("nome inválido %j é rejeitado", async (name) => {
    const a = await makeUser("Ana");
    auth.userId = a.id;
    expect(await updateMyAccountAction({ name })).toMatchObject({ ok: false, error: { code: "INVALID_PAYLOAD" } });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: a.id } })).name).toBe("Ana");
  });

  it("sem sessão: UNAUTHENTICATED", async () => {
    expect(await getMyAccountAction()).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    expect(await updateMyAccountAction({ name: "Ana" })).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
  });
});

describe("linha do tempo prefere o nome do usuário ao e-mail", () => {
  it("authorLabel = User.name; sem nome, cai na parte local do e-mail", async () => {
    const tenant = await prisma.tenant.create({ data: { slug: `it-tl-${randomUUID().slice(0, 8)}`, name: "TL", timezone: "UTC" } });
    tenantIds.push(tenant.id);
    const named = await prisma.user.create({ data: { email: `named-${randomUUID().slice(0, 6)}@example.com`, passwordHash: "x", name: "Paula Lima" } });
    const unnamedLocal = `semnome-${randomUUID().slice(0, 6)}`;
    const unnamed = await prisma.user.create({ data: { email: `${unnamedLocal}@example.com`, passwordHash: "x" } });
    userIds.push(named.id, unnamed.id);
    const membership = await prisma.membership.create({ data: { userId: named.id, tenantId: tenant.id, role: "OWNER" } });
    await prisma.membership.create({ data: { userId: unnamed.id, tenantId: tenant.id, role: "STAFF" } });
    const service = await prisma.service.create({ data: { tenantId: tenant.id, name: "S", durationMin: 30 } });
    const professional = await prisma.professional.create({ data: { tenantId: tenant.id, name: "P" } });
    const contact = await prisma.contact.create({ data: { tenantId: tenant.id, waJid: `5511${Math.floor(100000000 + Math.random() * 899999999)}@s.whatsapp.net` } });
    const startsAt = new Date(Date.now() + 86_400_000);
    const appt = await prisma.appointment.create({
      data: { tenantId: tenant.id, contactId: contact.id, serviceId: service.id, professionalId: professional.id, startsAt, endsAt: startsAt, blockEndsAt: startsAt },
    });
    await prisma.appointmentEvent.create({ data: { appointmentId: appt.id, action: "CREATED", authorType: "USER", authorId: named.id } });
    await prisma.appointmentEvent.create({ data: { appointmentId: appt.id, action: "CANCELED", authorType: "USER", authorId: unnamed.id } });

    const ctx: TenantContext = {
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, timezone: tenant.timezone },
      membership: { id: membership.id, role: "OWNER" },
      user: { id: named.id },
    };
    const { items } = await getAppointmentTimeline(ctx, appt.id);
    expect(items.map((i) => i.authorLabel)).toEqual(["Paula Lima", unnamedLocal]);
  });
});

describe("getWhatsappPageExtrasAction", () => {
  async function makeWorld(label: string, opts: { override?: number | null; planMax?: number; withSubscription?: boolean } = {}) {
    const tenant = await prisma.tenant.create({
      data: { slug: `it-wx-${label}-${randomUUID().slice(0, 8)}`, name: `Studio ${label}`, timezone: "UTC", maxWhatsappNumbersOverride: opts.override ?? null },
    });
    tenantIds.push(tenant.id);
    if (opts.withSubscription !== false) {
      const plan = await prisma.plan.create({
        data: { code: `it-wx-${randomUUID().slice(0, 8)}`, name: "Plano IT", priceCents: 4990, maxWhatsappNumbers: opts.planMax ?? 2, maxProfessionals: 5, active: false, sortOrder: 999 },
      });
      planIds.push(plan.id);
      await prisma.subscription.create({
        data: { tenantId: tenant.id, planId: plan.id, status: "TRIALING", trialEndsAt: new Date(Date.now() + 86_400_000), currentPeriodEnd: new Date(Date.now() + 86_400_000) },
      });
    }
    const user = await prisma.user.create({ data: { email: `wx-${randomUUID().slice(0, 8)}@example.com`, passwordHash: "x" } });
    userIds.push(user.id);
    const membership = await prisma.membership.create({ data: { userId: user.id, tenantId: tenant.id, role: "STAFF" } });
    auth.ctx = {
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, timezone: tenant.timezone },
      membership: { id: membership.id, role: "STAFF" },
      user: { id: user.id },
    };
    return tenant;
  }
  const addInstance = (tenantId: string, deletedAt: Date | null = null) =>
    prisma.whatsappInstance.create({ data: { tenantId, instanceName: `inst-wx-${randomUUID().slice(0, 8)}`, label: "N", webhookToken: randomUUID(), deletedAt } });

  it("limite do plano + números não removidos + prévia com as variáveis resolvidas (qualquer membro lê)", async () => {
    const tenant = await makeWorld("plan", { planMax: 2 });
    await addInstance(tenant.id);
    await addInstance(tenant.id, new Date()); // removida: não conta

    const r = await getWhatsappPageExtrasAction({ tenantSlug: tenant.slug });
    expect(r).toEqual({
      ok: true,
      data: {
        maxNumbers: 2,
        usedNumbers: 1,
        welcomePreview: {
          greeting: "Olá, Maria! Bem-vindo(a) à Studio plan. 😊",
          menu: "Como posso ajudar?\n1. Agendar horário\n2. Meus agendamentos\n3. Falar com atendente",
        },
      },
    });
  });

  it("override da empresa vence o plano; sem limite definido = null (ilimitado)", async () => {
    const over = await makeWorld("over", { planMax: 1, override: 7 });
    expect(await getWhatsappPageExtrasAction({ tenantSlug: over.slug })).toMatchObject({ ok: true, data: { maxNumbers: 7, usedNumbers: 0 } });

    const none = await makeWorld("none", { withSubscription: false });
    expect(await getWhatsappPageExtrasAction({ tenantSlug: none.slug })).toMatchObject({ ok: true, data: { maxNumbers: null } });
  });

  it("usa os textos GREETING/MAIN_MENU editados pela empresa", async () => {
    const tenant = await makeWorld("custom");
    await prisma.botText.create({ data: { tenantId: tenant.id, key: "GREETING", text: "Fala {nome}! Aqui é a {empresa}." } });
    await prisma.botText.create({ data: { tenantId: tenant.id, key: "MAIN_MENU", text: "1. Marcar\n2. Falar comigo" } });
    const r = await getWhatsappPageExtrasAction({ tenantSlug: tenant.slug });
    expect(r).toMatchObject({ ok: true, data: { welcomePreview: { greeting: "Fala Maria! Aqui é a Studio custom.", menu: "1. Marcar\n2. Falar comigo" } } });
  });

  it("outra empresa: NOT_FOUND; slug ausente: INVALID_PAYLOAD", async () => {
    const mine = await makeWorld("iso");
    const other = await prisma.tenant.create({ data: { slug: `it-wx-other-${randomUUID().slice(0, 8)}`, name: "Outra", timezone: "UTC" } });
    tenantIds.push(other.id);
    await addInstance(other.id);
    expect(await getWhatsappPageExtrasAction({ tenantSlug: other.slug })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await getWhatsappPageExtrasAction({})).toMatchObject({ ok: false, error: { code: "INVALID_PAYLOAD" } });
    expect(await getWhatsappPageExtrasAction({ tenantSlug: mine.slug })).toMatchObject({ ok: true, data: { usedNumbers: 0 } });
  });
});
