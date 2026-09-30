/**
 * Acesso direto ao Postgres de DEV para montar/desmontar fixtures que a UI não tem como criar
 * (segunda empresa, membro STAFF, bloqueio da empresa inteira — não há tela para isso ainda, ver
 * o handoff). Mesma convenção dos testes de integração: Prisma direto, sem passar pela camada
 * HTTP/Server Action (aqui é só SETUP, o que É testado pela UI continua sendo exercitado pelo
 * Playwright de verdade).
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

export const prisma = new PrismaClient();

const SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function ensureBotPlan() {
  const existing = await prisma.plan.findFirst({ where: { code: "e2e-plan" } });
  if (existing) return existing;
  return prisma.plan.create({
    data: { code: "e2e-plan", name: "Plano E2E", priceCents: 0, maxWhatsappNumbers: 3, maxProfessionals: null, active: false, sortOrder: 999 },
  });
}

/**
 * Fixa a versão do fluxo do bot "publicada" (`PlatformSettings.n8nBotFlowVersion`), que decide se a
 * tela "Mensagens do bot" mostra o catálogo v1 ou v2. Devolve o valor anterior para o teste
 * restaurar no `afterAll`/`finally` (a linha única de `PlatformSettings` é compartilhada com as
 * outras specs de admin).
 */
export async function setPublishedFlowVersion(version: string | null): Promise<string | null> {
  const before = await prisma.platformSettings.findUnique({ where: { id: 1 }, select: { n8nBotFlowVersion: true } });
  await prisma.platformSettings.upsert({
    where: { id: 1 },
    update: { n8nBotFlowVersion: version },
    create: { id: 1, n8nBotFlowVersion: version },
  });
  return before?.n8nBotFlowVersion ?? null;
}
