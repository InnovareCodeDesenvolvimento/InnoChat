import { createHmac, timingSafeEqual } from "node:crypto";
import { getPrisma } from "@/lib/db/prisma";
import type { SupportSessionCloseReason } from "@/lib/db/types";
import { DomainError } from "@/lib/errors";

export const SUPPORT_SESSION_TTL_MS = 60 * 60 * 1000; // 1 hora
const MIN_SECRET_LENGTH = 16;

export type SupportCookiePayload = {
  sessionId: string;
  adminUserId: string;
  tenantId: string;
  tenantSlug: string;
  exp: number; // timestamp em ms
};

function getAuthSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error("AUTH_SECRET ausente ou muito curto para assinar sessão de suporte.");
  }
  return secret;
}

export function signSupportCookiePayload(payload: SupportCookiePayload): string {
  const secret = getAuthSecret();
  const json = JSON.stringify(payload);
  const dataB64 = Buffer.from(json, "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(dataB64).digest("base64url");
  return `${dataB64}.${signature}`;
}

export function verifySupportCookiePayload(cookieValue: string): SupportCookiePayload | null {
  try {
    const parts = cookieValue.split(".");
    if (parts.length !== 2) return null;
    const [dataB64, signature] = parts;
    const secret = getAuthSecret();
    const expectedSig = createHmac("sha256", secret).update(dataB64).digest("base64url");

    const a = Buffer.from(signature, "utf8");
    const b = Buffer.from(expectedSig, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return null;
    }

    const json = Buffer.from(dataB64, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as Partial<SupportCookiePayload>;

    if (
      typeof parsed.sessionId !== "string" ||
      typeof parsed.adminUserId !== "string" ||
      typeof parsed.tenantId !== "string" ||
      typeof parsed.tenantSlug !== "string" ||
      typeof parsed.exp !== "number"
    ) {
      return null;
    }

    return parsed as SupportCookiePayload;
  } catch {
    return null;
  }
}

export type StartSupportSessionInput = {
  adminUserId: string;
  tenantId: string;
  reason: string;
  ip: string | null;
  userAgent: string | null;
};

export type StartSupportSessionResult = {
  sessionId: string;
  expiresAt: Date;
  cookieValue: string;
  tenantSlug: string;
};

export type ValidateSupportSessionInput = {
  cookieValue: string;
};

export type ValidateSupportSessionResult =
  | {
      ok: true;
      adminUserId: string;
      tenantId: string;
      tenantSlug: string;
      sessionId: string;
      expiresAt: Date;
    }
  | {
      ok: false;
      reason: "EXPIRED" | "REVOKED" | "INVALID";
      tenantId?: string;
    };

export type CloseSupportSessionInput = {
  sessionId: string;
  reason: "EXITED" | "EXPIRED" | "REVOKED";
};

export async function startSupportSession(
  input: StartSupportSessionInput
): Promise<StartSupportSessionResult> {
  const prisma = getPrisma();

  const admin = await prisma.user.findUnique({
    where: { id: input.adminUserId },
    select: { id: true, isPlatformAdmin: true, totpEnabledAt: true },
  });

  if (!admin?.isPlatformAdmin) {
    throw new DomainError("FORBIDDEN", "Apenas administradores da plataforma podem iniciar suporte.");
  }

  if (!admin.totpEnabledAt) {
    throw new DomainError(
      "TWO_FACTOR_SETUP_REQUIRED",
      "É obrigatório ter a verificação em duas etapas ativa para impersonar empresas."
    );
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: input.tenantId },
    select: { id: true, slug: true, subscription: { select: { status: true } } },
  });

  if (!tenant || tenant.subscription?.status === "CANCELED") {
    throw new DomainError("NOT_FOUND", "Empresa não encontrada ou inativa.");
  }

  const trimmedReason = input.reason.trim();
  if (trimmedReason.length < 15 || trimmedReason.length > 500) {
    throw new DomainError(
      "INVALID_REASON",
      "O motivo da sessão de suporte deve conter entre 15 e 500 caracteres explicativos."
    );
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + SUPPORT_SESSION_TTL_MS);

  // Idempotência leve: revoga quaisquer sessões ainda abertas deste admin antes de abrir uma nova
  await prisma.supportSession.updateMany({
    where: {
      adminUserId: admin.id,
      closedAt: null,
    },
    data: {
      closedAt: now,
      closeReason: "REVOKED",
    },
  });

  const session = await prisma.supportSession.create({
    data: {
      tenantId: tenant.id,
      adminUserId: admin.id,
      reason: trimmedReason,
      startedAt: now,
      expiresAt,
    },
  });

  const cookieValue = signSupportCookiePayload({
    sessionId: session.id,
    adminUserId: admin.id,
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    exp: expiresAt.getTime(),
  });

  return {
    sessionId: session.id,
    expiresAt,
    cookieValue,
    tenantSlug: tenant.slug,
  };
}

export async function validateSupportSession(
  input: ValidateSupportSessionInput
): Promise<ValidateSupportSessionResult> {
  const payload = verifySupportCookiePayload(input.cookieValue);
  if (!payload) {
    return { ok: false, reason: "INVALID" };
  }

  const prisma = getPrisma();
  const now = new Date();

  // Relê o banco a cada chamada
  const session = await prisma.supportSession.findUnique({
    where: { id: payload.sessionId },
    include: {
      admin: {
        select: { id: true, isPlatformAdmin: true, totpEnabledAt: true },
      },
      tenant: {
        select: { id: true, slug: true, subscription: { select: { status: true } } },
      },
    },
  });

  if (!session) {
    return { ok: false, reason: "INVALID" };
  }

  // Se já estava fechada
  if (session.closedAt) {
    return {
      ok: false,
      reason: session.closeReason === "EXPIRED" ? "EXPIRED" : "REVOKED",
      tenantId: session.tenantId,
    };
  }

  // Se expirou pelo tempo
  if (now > session.expiresAt || now.getTime() > payload.exp) {
    await prisma.supportSession.updateMany({
      where: { id: session.id, closedAt: null },
      data: {
        closedAt: now,
        closeReason: "EXPIRED",
      },
    });
    return { ok: false, reason: "EXPIRED", tenantId: session.tenantId };
  }

  // Se admin perdeu status ou tenant foi inativado (cancelado)
  if (!session.admin.isPlatformAdmin || !session.admin.totpEnabledAt || session.tenant.subscription?.status === "CANCELED") {
    await prisma.supportSession.updateMany({
      where: { id: session.id, closedAt: null },
      data: {
        closedAt: now,
        closeReason: "REVOKED",
      },
    });
    return { ok: false, reason: "REVOKED", tenantId: session.tenantId };
  }

  return {
    ok: true,
    adminUserId: session.adminUserId,
    tenantId: session.tenantId,
    tenantSlug: session.tenant.slug,
    sessionId: session.id,
    expiresAt: session.expiresAt,
  };
}

export async function closeSupportSession(
  input: CloseSupportSessionInput
): Promise<{ closed: boolean }> {
  const prisma = getPrisma();
  const now = new Date();

  const result = await prisma.supportSession.updateMany({
    where: {
      id: input.sessionId,
      closedAt: null,
    },
    data: {
      closedAt: now,
      closeReason: input.reason as SupportSessionCloseReason,
    },
  });

  return { closed: result.count > 0 };
}
