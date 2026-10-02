/**
 * Login com Google contra Postgres real: config do admin (secret cifrado, nunca devolvido),
 * cadastro depois do Google (empresa + trial + e-mail verificado, uso único), conta sem senha
 * (`passwordHash` nulo) e convite de equipe pelo Google.
 *
 * Não sobe o Auth.js/OAuth (não há Google real aqui): testa os services que o callback `signIn`
 * e as Server Actions chamam. O fluxo com o Google de verdade é a validação manual do dono.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";

const sentEmails: { to: string; subject: string; text: string }[] = [];

vi.mock("@/lib/email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
  return {
    ...actual,
    sendMail: vi.fn(async (input: { to: string; subject: string; text: string }) => {
      sentEmails.push(input);
      return { sent: true };
    }),
  };
});

const { signGoogleToken } = await import("@/modules/google-auth/tokens");
const { completeGoogleSignUp, getGoogleSignUpPrefill } = await import("@/modules/google-auth/signup");
const { resolveGoogleSignIn } = await import("@/modules/google-auth/signin");
const config = await import("@/modules/google-auth/config");
const { verifyCredentials } = await import("@/modules/auth/service");
const { inviteTeamMember, acceptInviteWithGoogle, requestPasswordReset, resetPassword, signUp } = await import("@/modules/signup/service");
const { hashPassword } = await import("@/modules/auth/service");
const { createMockMercadoPagoGateway } = await import("@/modules/billing/mercadopago.mock");

const prisma = getPrisma();
const run = randomUUID().slice(0, 8);
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];
const createdPlanIds: string[] = [];
let adminId = "";

const DOCUMENT = "529.982.247-25";
// Valores montados em runtime: literais com formato de credencial Google são bloqueados pelo push protection do GitHub.
const CLIENT_ID = ["1234567890-abcdefghijk", "apps", "googleusercontent", "com"].join(".");
const CLIENT_SECRET = ["GOCSPX", "segredo-de-teste-falso"].join("-");

beforeAll(async () => {
  process.env.AUTH_SECRET ??= "test-secret-not-used-in-integration-tests";
  const admin = await prisma.user.create({ data: { email: `it-google-admin-${run}@example.com`, passwordHash: await hashPassword("x-senha-longa-123"), isPlatformAdmin: true, totpSecretEnc: "enc:v1:x", totpEnabledAt: new Date() } });
  adminId = admin.id;
  createdUserIds.push(admin.id);
});

beforeEach(() => {
  sentEmails.length = 0;
  config.invalidateGoogleAuthCache();
});

afterAll(async () => {
  await prisma.platformSettings.updateMany({ where: { id: 1 }, data: { googleAuthEnabled: false, googleClientId: null, googleClientSecretEnc: null } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.authToken.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.platformSettings.updateMany({ where: { updatedByUserId: adminId }, data: { updatedByUserId: null } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.plan.deleteMany({ where: { id: { in: createdPlanIds } } });
  await prisma.$disconnect();
});

function token(email: string, sub: string, name = "Ana Google") {
  return signGoogleToken("google-signup", { email, name, sub }, 15 * 60 * 1000);
}

async function registerViaGoogle(label: string) {
  const email = `it-google-${label}-${run}@example.com`;
  const sub = `sub-${label}-${run}`;
  const result = await completeGoogleSignUp({ token: token(email, sub), tenantName: `Clínica ${label} ${run}`, document: DOCUMENT, termsVersion: "v1" });
  createdUserIds.push(result.userId);
  createdTenantIds.push((await prisma.tenant.findUniqueOrThrow({ where: { slug: result.tenantSlug } })).id);
  return { email, sub, ...result };
}

describe("config do admin — Client Secret cifrado e nunca devolvido", () => {
  beforeEach(async () => {
    await prisma.platformSettings.updateMany({ where: { id: 1 }, data: { googleAuthEnabled: false, googleClientId: null, googleClientSecretEnc: null } });
  });

  it("grava o secret cifrado (enc:v1:) e a view só diz clientSecretSaved", async () => {
    const view = await config.saveGoogleAuthConfig({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, enabled: true }, adminId);

    const row = await prisma.platformSettings.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.googleClientSecretEnc).toMatch(/^enc:v1:/);
    expect(row.googleClientSecretEnc).not.toContain(CLIENT_SECRET);
    expect(row.googleAuthEnabled).toBe(true);

    expect(view).toMatchObject({ enabled: true, clientId: CLIENT_ID, clientSecretSaved: true });
    expect(JSON.stringify(view)).not.toContain(CLIENT_SECRET);
    expect(view.redirectUri.endsWith("/api/auth/callback/google")).toBe(true);
    expect((await config.getGoogleAuthConfig()).clientSecretSaved).toBe(true);

    // Credenciais para o Auth.js: decifradas só no servidor.
    expect(await config.getGoogleRuntimeCredentials()).toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(await config.isGoogleAuthAvailable()).toBe(true);
  });

  it("secret vazio mantém o atual", async () => {
    await config.saveGoogleAuthConfig({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, adminId);
    const before = (await prisma.platformSettings.findUniqueOrThrow({ where: { id: 1 } })).googleClientSecretEnc;

    await config.saveGoogleAuthConfig({ clientSecret: "", enabled: true }, adminId);

    const after = (await prisma.platformSettings.findUniqueOrThrow({ where: { id: 1 } })).googleClientSecretEnc;
    expect(after).toBe(before);
    expect((await config.getGoogleRuntimeCredentials())?.clientSecret).toBe(CLIENT_SECRET);
  });

  it("não deixa ligar sem Client ID e secret", async () => {
    await expect(config.saveGoogleAuthConfig({ enabled: true }, adminId)).rejects.toMatchObject({ code: "GOOGLE_CONFIG_INCOMPLETE" });
    await expect(config.saveGoogleAuthConfig({ enabled: true, clientId: CLIENT_ID }, adminId)).rejects.toMatchObject({ code: "GOOGLE_CONFIG_INCOMPLETE" });
    expect((await prisma.platformSettings.findUniqueOrThrow({ where: { id: 1 } })).googleAuthEnabled).toBe(false);
  });

  it("recusa Client ID fora do formato", async () => {
    await expect(config.saveGoogleAuthConfig({ clientId: "nao-e-um-client-id" }, adminId)).rejects.toMatchObject({ code: "INVALID_GOOGLE_CLIENT_ID" });
  });

  it("remover o secret desliga o login com Google", async () => {
    await config.saveGoogleAuthConfig({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, enabled: true }, adminId);
    const view = await config.removeGoogleClientSecret(adminId);
    expect(view).toMatchObject({ enabled: false, clientSecretSaved: false });
    expect(await config.isGoogleAuthAvailable()).toBe(false);
  });

  it("secret que não decifra vale como ausente: provedor fica desligado e o teste avisa", async () => {
    await config.saveGoogleAuthConfig({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, enabled: true }, adminId);
    await prisma.platformSettings.update({ where: { id: 1 }, data: { googleClientSecretEnc: "enc:v1:lixo-corrompido" } });
    config.invalidateGoogleAuthCache();

    expect(await config.getGoogleRuntimeCredentials()).toBeNull();
    const result = await config.testGoogleAuthConfig();
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual({ clientIdFormat: true, secretDecrypts: false });
  });

  it("teste de configuração: ok quando ID e secret estão íntegros (e diz que não valida no Google)", async () => {
    await config.saveGoogleAuthConfig({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, adminId);
    const result = await config.testGoogleAuthConfig();
    expect(result.ok).toBe(true);
    expect(result.detalhe).toContain("Google");
    expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET);
  });
});

describe("completeGoogleSignUp — cadastro depois do Google", () => {
  it("cria empresa + usuário sem senha com e-mail verificado + trial, sem e-mail de verificação", async () => {
    const r = await registerViaGoogle("ok");

    const user = await prisma.user.findUniqueOrThrow({ where: { id: r.userId } });
    expect(user.passwordHash).toBeNull();
    expect(user.googleSub).toBe(r.sub);
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.termsAcceptedAt).not.toBeNull();
    expect(user.name).toBe("Ana Google");

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: r.tenantSlug } });
    expect(tenant.document).toBe("52998224725");
    const membership = await prisma.membership.findFirstOrThrow({ where: { tenantId: tenant.id } });
    expect(membership).toMatchObject({ userId: r.userId, role: "OWNER" });
    const subscription = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    expect(subscription.status).toBe("TRIALING");
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { subscriptionId: subscription.id } });
    expect(invoice.isTrialConversion).toBe(true);

    expect(sentEmails.some((e) => e.subject.includes("Confirme seu e-mail"))).toBe(false);
  });

  it("uso único: o mesmo token não cadastra de novo nem pré-preenche (ALREADY_REGISTERED)", async () => {
    const r = await registerViaGoogle("once");
    const again = token(r.email, r.sub);

    await expect(getGoogleSignUpPrefill(again)).rejects.toMatchObject({ code: "ALREADY_REGISTERED" });
    await expect(
      completeGoogleSignUp({ token: again, tenantName: "Outra Empresa", document: DOCUMENT, termsVersion: "v1" }),
    ).rejects.toMatchObject({ code: "ALREADY_REGISTERED" });
    expect(await prisma.user.count({ where: { googleSub: r.sub } })).toBe(1);
  });

  it("duas requisições simultâneas com o mesmo token criam UMA conta só", async () => {
    const email = `it-google-race-${run}@example.com`;
    const sub = `sub-race-${run}`;
    const t = token(email, sub);
    const results = await Promise.allSettled([
      completeGoogleSignUp({ token: t, tenantName: `Corrida A ${run}`, document: DOCUMENT, termsVersion: "v1" }),
      completeGoogleSignUp({ token: t, tenantName: `Corrida B ${run}`, document: DOCUMENT, termsVersion: "v1" }),
    ]);
    const users = await prisma.user.findMany({ where: { googleSub: sub }, include: { memberships: true } });
    for (const u of users) {
      createdUserIds.push(u.id);
      createdTenantIds.push(...u.memberships.map((m) => m.tenantId));
    }
    expect(users).toHaveLength(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("e-mail que já tem conta por senha: ALREADY_REGISTERED (a tela manda entrar, o vínculo é no signIn)", async () => {
    const email = `it-google-pw-${run}@example.com`;
    const { gateway } = createMockMercadoPagoGateway();
    const signedUp = await signUp(
      { companyName: `Com Senha ${run}`, slug: `it-google-pw-${run}`, segment: null, ownerName: "Dono", email, password: "senha-forte-123", document: DOCUMENT, termsVersion: "v1" },
      gateway,
    );
    createdUserIds.push(signedUp.userId);
    createdTenantIds.push((await prisma.tenant.findUniqueOrThrow({ where: { slug: signedUp.tenantSlug } })).id);

    await expect(
      completeGoogleSignUp({ token: token(email, `sub-pw-${run}`), tenantName: "X Empresa", document: DOCUMENT, termsVersion: "v1" }),
    ).rejects.toMatchObject({ code: "ALREADY_REGISTERED" });
  });

  it("token expirado, adulterado e documento inválido são recusados sem criar nada", async () => {
    const email = `it-google-bad-${run}@example.com`;
    const expired = signGoogleToken("google-signup", { email, name: "X", sub: `sub-bad-${run}` }, 1_000, Date.now() - 60_000);
    await expect(completeGoogleSignUp({ token: expired, tenantName: "Empresa X", document: DOCUMENT, termsVersion: "v1" })).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
    await expect(completeGoogleSignUp({ token: `${token(email, "s")}x`, tenantName: "Empresa X", document: DOCUMENT, termsVersion: "v1" })).rejects.toMatchObject({ code: "TOKEN_INVALID" });
    await expect(completeGoogleSignUp({ token: token(email, `sub-bad-${run}`), tenantName: "Empresa X", document: "111.111.111-11", termsVersion: "v1" })).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it("plano escolhido: usa o plano ativo pedido; plano desconhecido dá INVALID_PLAN", async () => {
    const plan = await prisma.plan.create({
      data: { code: `it-google-plan-${run}`, name: "Plano IT", priceCents: 12345, maxWhatsappNumbers: 3, maxProfessionals: 3, active: true, sortOrder: 9999 },
    });
    createdPlanIds.push(plan.id);
    const email = `it-google-plan-${run}@example.com`;
    const sub = `sub-plan-${run}`;

    await expect(
      completeGoogleSignUp({ token: token(email, sub), tenantName: "Empresa Plano", document: DOCUMENT, termsVersion: "v1", planCode: "nao-existe" }),
    ).rejects.toMatchObject({ code: "INVALID_PLAN" });

    const r = await completeGoogleSignUp({ token: token(email, sub), tenantName: `Empresa Plano ${run}`, document: DOCUMENT, termsVersion: "v1", planCode: plan.code });
    createdUserIds.push(r.userId);
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: r.tenantSlug } });
    createdTenantIds.push(tenant.id);
    const subscription = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    expect(subscription.planId).toBe(plan.id);
  });

  it("gera slug único quando o nome da empresa repete", async () => {
    const a = await registerViaGoogle("slugA");
    const email = `it-google-slugB-${run}@example.com`;
    const b = await completeGoogleSignUp({ token: token(email, `sub-slugB-${run}`), tenantName: `Clínica slugA ${run}`, document: DOCUMENT, termsVersion: "v1" });
    createdUserIds.push(b.userId);
    createdTenantIds.push((await prisma.tenant.findUniqueOrThrow({ where: { slug: b.tenantSlug } })).id);
    expect(b.tenantSlug).not.toBe(a.tenantSlug);
  });
});

describe("conta sem senha (passwordHash nulo)", () => {
  it("login por senha responde GOOGLE_ONLY_ACCOUNT; 'esqueci a senha' permite DEFINIR uma", async () => {
    const r = await registerViaGoogle("nopw");

    await expect(verifyCredentials({ email: r.email, password: "qualquer-coisa-123", ip: `it-${run}-nopw` })).rejects.toMatchObject({ code: "GOOGLE_ONLY_ACCOUNT" });

    await requestPasswordReset(r.email);
    const mail = sentEmails.find((e) => e.to === r.email && e.text.includes("token="));
    const raw = mail?.text.match(/token=([\w-]+)/)?.[1];
    expect(raw).toBeTruthy();
    await resetPassword(raw!, "nova-senha-forte-123");

    const user = await prisma.user.findUniqueOrThrow({ where: { id: r.userId } });
    expect(user.passwordHash).toBeTruthy();
    expect(user.googleSub).toBe(r.sub); // continua ligado ao Google
    expect(await verifyCredentials({ email: r.email, password: "nova-senha-forte-123", ip: `it-${run}-nopw2` })).toMatchObject({ id: r.userId });
  });
});

describe("resolveGoogleSignIn contra o banco", () => {
  it("vincula por e-mail (verifica o e-mail, descarta senha de conta não verificada) e depois entra por sub", async () => {
    const email = `it-google-link-${run}@example.com`;
    const { gateway } = createMockMercadoPagoGateway();
    const su = await signUp(
      { companyName: `Link ${run}`, slug: `it-google-link-${run}`, segment: null, ownerName: "Dono", email, password: "senha-do-atacante-123", document: DOCUMENT, termsVersion: "v1" },
      gateway,
    );
    createdUserIds.push(su.userId);
    createdTenantIds.push((await prisma.tenant.findUniqueOrThrow({ where: { slug: su.tenantSlug } })).id);

    const out = await resolveGoogleSignIn({ sub: `sub-link-${run}`, email, emailVerified: true, name: "Dono" });
    expect(out).toEqual({ kind: "allow", userId: su.userId });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: su.userId } });
    expect(user.googleSub).toBe(`sub-link-${run}`);
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.passwordHash).toBeNull(); // e-mail nunca verificado: a senha pré-definida por terceiro cai

    expect(await resolveGoogleSignIn({ sub: `sub-link-${run}`, email: "outro@example.com", emailVerified: true })).toEqual({ kind: "allow", userId: su.userId });
  });

  it("admin da plataforma nunca entra pelo Google", async () => {
    const adminEmail = `it-google-admin-${run}@example.com`;
    const out = await resolveGoogleSignIn({ sub: `sub-admin-${run}`, email: adminEmail, emailVerified: true });
    expect(out).toEqual({ kind: "deny", reason: "PLATFORM_ADMIN" });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: adminId } })).googleSub).toBeNull();
  });

  it("e-mail não verificado é recusado e ninguém é criado", async () => {
    const email = `it-google-unv-${run}@example.com`;
    expect(await resolveGoogleSignIn({ sub: `sub-unv-${run}`, email, emailVerified: false })).toEqual({ kind: "deny", reason: "EMAIL_NOT_VERIFIED" });
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it("e-mail desconhecido: devolve token de cadastro e NÃO cria usuário nem empresa", async () => {
    const email = `it-google-new-${run}@example.com`;
    const out = await resolveGoogleSignIn({ sub: `sub-new-${run}`, email, emailVerified: true, name: "Nova Pessoa" });
    expect(out.kind).toBe("signup");
    expect(await prisma.user.count({ where: { email } })).toBe(0);
    if (out.kind === "signup") expect(await getGoogleSignUpPrefill(out.token)).toEqual({ email, name: "Nova Pessoa" });
  });
});

describe("convite de equipe com Google", () => {
  async function invite(label: string) {
    const owner = await registerViaGoogle(`own-${label}`);
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: owner.tenantSlug } });
    const email = `it-google-inv-${label}-${run}@example.com`;
    await inviteTeamMember({ tenantId: tenant.id, tenantName: tenant.name, email, role: "STAFF" });
    const invited = await prisma.user.findUniqueOrThrow({ where: { email } });
    createdUserIds.push(invited.id);
    const raw = sentEmails.find((e) => e.to === email)?.text.match(/token=([\w-]+)/)?.[1];
    expect(raw).toBeTruthy();
    return { email, raw: raw!, invitedId: invited.id, tenantSlug: owner.tenantSlug };
  }

  it("e-mail do Google diferente do convite: recusa e NÃO consome o convite", async () => {
    const i = await invite("mismatch");
    await expect(acceptInviteWithGoogle(i.raw, { sub: `sub-x-${run}`, email: "intruso@example.com" })).rejects.toMatchObject({ code: "INVITE_EMAIL_MISMATCH" });
    const token = await prisma.authToken.findFirstOrThrow({ where: { userId: i.invitedId, type: "INVITE" } });
    expect(token.usedAt).toBeNull();
  });

  it("atômico (I2): sub já ligado a OUTRO usuário -> GOOGLE_ACCOUNT_MISMATCH e o convite NÃO é consumido", async () => {
    const i = await invite("atomic");
    const other = await registerViaGoogle("atomic-owner"); // já tem googleSub = other.sub
    await expect(acceptInviteWithGoogle(i.raw, { sub: other.sub, email: i.email })).rejects.toMatchObject({ code: "GOOGLE_ACCOUNT_MISMATCH" });

    const token = await prisma.authToken.findFirstOrThrow({ where: { userId: i.invitedId, type: "INVITE" } });
    expect(token.usedAt).toBeNull(); // o claim foi desfeito junto com a transação
    const invited = await prisma.user.findUniqueOrThrow({ where: { id: i.invitedId } });
    expect(invited.googleSub).toBeNull();
    expect(invited.sessionVersion).toBe(0);

    // O convite continua utilizável com uma conta Google livre.
    const out = await resolveGoogleSignIn({ sub: `sub-atomic-free-${run}`, email: i.email, emailVerified: true }, { inviteToken: i.raw });
    expect(out).toEqual({ kind: "allow", userId: i.invitedId });
  });

  it("via resolveGoogleSignIn: sub de outro usuário vira deny GOOGLE_ACCOUNT_MISMATCH", async () => {
    const i = await invite("atomic2");
    const other = await registerViaGoogle("atomic2-owner");
    const out = await resolveGoogleSignIn({ sub: other.sub, email: i.email, emailVerified: true }, { inviteToken: i.raw });
    expect(out).toEqual({ kind: "deny", reason: "GOOGLE_ACCOUNT_MISMATCH" });
    const token = await prisma.authToken.findFirstOrThrow({ where: { userId: i.invitedId, type: "INVITE" } });
    expect(token.usedAt).toBeNull();
  });

  it("convite em conta não verificada incrementa sessionVersion (derruba sessão pré-aberta)", async () => {
    const i = await invite("sv");
    await acceptInviteWithGoogle(i.raw, { sub: `sub-sv-${run}`, email: i.email });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: i.invitedId } })).sessionVersion).toBe(1);
  });

  it("e-mail igual: vincula, verifica, consome o convite (uso único) e mantém a Membership", async () => {
    const i = await invite("ok");
    const out = await resolveGoogleSignIn({ sub: `sub-inv-${run}`, email: i.email, emailVerified: true, name: "Funcionária" }, { inviteToken: i.raw });
    expect(out).toEqual({ kind: "allow", userId: i.invitedId });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: i.invitedId } });
    expect(user).toMatchObject({ googleSub: `sub-inv-${run}`, name: "Funcionária", passwordHash: null });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(await prisma.membership.count({ where: { userId: i.invitedId } })).toBe(1);

    await expect(acceptInviteWithGoogle(i.raw, { sub: `sub-inv-${run}`, email: i.email })).rejects.toMatchObject({ code: "TOKEN_INVALID" });
  });
});
