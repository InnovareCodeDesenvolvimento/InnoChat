import fs from "node:fs";
import { prisma } from "./fixtures/db";
import { SEED_TENANT_SLUG, STABLE_MARKER, loadRunFixtures } from "./fixtures/test-data";
import { disableTwoFactorForSeedOwner } from "./fixtures/two-factor";

/**
 * Limpa TUDO que o E2E criou (global-setup + o que as specs criaram por Server Action durante o
 * teste) — nunca toca no tenant/usuário de seed (`studio-demo` / `dev@innochat.local`).
 * `onDelete: Cascade` no schema cuida de professionals/services/appointments/etc pendurados no
 * tenant B; para a empresa de seed, limpamos só o que tem a marca do run no nome.
 */
export default async function globalTeardown() {
  try {
    const fixtures = loadRunFixtures();
    await prisma.tenant.deleteMany({ where: { slug: fixtures.tenantBSlug } });
    await prisma.user.deleteMany({ where: { email: { in: [fixtures.staffEmail, fixtures.tenantBOwnerEmail] } } });
  } catch {
    // Arquivo de fixtures não existe (setup falhou antes de escrever) — segue para a limpeza
    // por marca estável abaixo, que não depende dele.
  }

  // Qualquer serviço/profissional/exceção/contato/agendamento criado pelas specs na empresa de
  // SEED, marcado com a marca estável no nome (`contains`, não `startsWith`, para pegar também
  // sobras de execuções anteriores interrompidas antes do teardown rodar).
  await prisma.appointment.deleteMany({ where: { contact: { name: { contains: STABLE_MARKER } } } });
  await prisma.contact.deleteMany({ where: { name: { contains: STABLE_MARKER } } });
  await prisma.service.deleteMany({ where: { name: { contains: STABLE_MARKER } } });
  await prisma.professional.deleteMany({ where: { name: { contains: STABLE_MARKER } } });
  await prisma.scheduleException.deleteMany({ where: { reason: { contains: STABLE_MARKER } } });

  // Desliga a 2FA de teste do dono de seed (o global-setup ligou).
  await disableTwoFactorForSeedOwner();

  // Devolve o override de limite de profissionais que o `global-setup.ts` levantou.
  await prisma.tenant.updateMany({ where: { slug: SEED_TENANT_SLUG }, data: { maxProfessionalsOverride: null } });

  try {
    fs.unlinkSync("./tests/e2e/.e2e-fixture-ids.json");
  } catch {
    // já não existe — ok.
  }

  try {
    fs.rmSync("./tests/e2e/.auth", { recursive: true, force: true });
  } catch {
    // já não existe — ok.
  }

  await prisma.$disconnect();
}
