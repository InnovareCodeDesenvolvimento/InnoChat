import { describe, expect, it, vi } from "vitest";

// Mock das actions e módulos de backend que dependem de next-auth/next/server em ambiente node do vitest
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/lib/auth/guards", () => ({
  requireTenantMember: vi.fn(),
  requireSessionUser: vi.fn(),
}));

vi.mock("@/modules/agenda/catalog-actions", () => ({
  createServiceAction: vi.fn(),
  updateServiceAction: vi.fn(),
  deleteServiceAction: vi.fn(),
  createProfessionalAction: vi.fn(),
  updateProfessionalAction: vi.fn(),
  deleteProfessionalAction: vi.fn(),
  setProfessionalServicesAction: vi.fn(),
  setProfessionalWorkingHoursAction: vi.fn(),
  createScheduleExceptionAction: vi.fn(),
  deleteScheduleExceptionAction: vi.fn(),
  setProfessionalCommissionAction: vi.fn(),
}));

vi.mock("@/modules/agenda/appointment-actions", () => ({
  listAppointmentsAction: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  createAppointmentAction: vi.fn(),
  cancelAppointmentAction: vi.fn(),
  completeAppointmentAction: vi.fn(),
  markNoShowAppointmentAction: vi.fn(),
  reopenAppointmentAction: vi.fn(),
  rescheduleAppointmentAction: vi.fn(),
}));

import { renderToStaticMarkup } from "react-dom/server";
import { ToastProvider } from "@/components/ui/toast";
import { HelpVisibilityProvider } from "@/components/help/help-visibility";
import { SupportModeBadge } from "@/components/support/SupportModeBadge";
import { ServicosClient } from "@/app/(app)/[tenantSlug]/servicos/servicos-client";
import { ProfissionaisClient } from "@/app/(app)/[tenantSlug]/profissionais/profissionais-client";
import { BloqueiosClient } from "@/app/(app)/[tenantSlug]/configuracoes/bloqueios/bloqueios-client";
import { AgendamentosClient } from "@/app/(app)/[tenantSlug]/agendamentos/agendamentos-client";
import { ProfessionalDetailClient } from "@/app/(app)/[tenantSlug]/profissionais/[professionalId]/professional-detail-client";

function withProviders(children: React.ReactNode) {
  return (
    <ToastProvider>
      <HelpVisibilityProvider>
        {children}
      </HelpVisibilityProvider>
    </ToastProvider>
  );
}

describe("Onda 2 — UI de suporte e catálogo", () => {
  describe("SupportModeBadge", () => {
    it("não renderiza nada se isSupportImpersonation for false ou undefined", () => {
      const htmlFalse = renderToStaticMarkup(<SupportModeBadge isSupportImpersonation={false} />);
      const htmlUndef = renderToStaticMarkup(<SupportModeBadge />);
      expect(htmlFalse).toBe("");
      expect(htmlUndef).toBe("");
    });

    it("renderiza pill 'Modo suporte ativo' quando isSupportImpersonation for true", () => {
      const html = renderToStaticMarkup(<SupportModeBadge isSupportImpersonation={true} defaultOpen={true} />);
      expect(html).toContain("Modo suporte ativo");
      expect(html).toContain("data-testid=\"support-mode-badge\"");
      expect(html).toContain("admin.modoSuporte");
    });
  });

  describe("Telas de catálogo — badge de suporte e ajuda contextual ⓘ", () => {
    it("Serviços exibe badge quando isSupportImpersonation=true e inclui chaves de ajuda", () => {
      const html = renderToStaticMarkup(
        withProviders(
          <ServicosClient
            tenantSlug="clinica-teste"
            initialServices={[
              { id: "s1", name: "Corte", durationMin: 30, bufferAfterMin: 0, priceCents: 5000, active: true, sortOrder: 0 },
            ]}
            isSupportImpersonation={true}
            defaultDialogOpen={true}
          />
        )
      );

      expect(html).toContain("data-testid=\"support-mode-badge\"");
      expect(html).toContain("data-help-key=\"catalogo.servicoNome\"");
      expect(html).toContain("data-help-key=\"catalogo.servicoDuracao\"");
      expect(html).toContain("data-help-key=\"catalogo.servicoIntervalo\"");
      expect(html).toContain("data-help-key=\"catalogo.servicoPreco\"");
      expect(html).toContain("data-help-key=\"catalogo.servicoOrdem\"");
      expect(html).toContain("data-help-key=\"catalogo.servicoAtivo\"");
      expect(html).toContain("Paginação dos serviços");
    });

    it("Serviços NÃO exibe badge quando isSupportImpersonation=false", () => {
      const html = renderToStaticMarkup(
        withProviders(
          <ServicosClient
            tenantSlug="clinica-teste"
            initialServices={[]}
            isSupportImpersonation={false}
          />
        )
      );
      expect(html).not.toContain("data-testid=\"support-mode-badge\"");
    });

    it("Profissionais exibe badge quando isSupportImpersonation=true e ajuda no modal", () => {
      const html = renderToStaticMarkup(
        withProviders(
          <ProfissionaisClient
            tenantSlug="clinica-teste"
            initialProfessionals={[
              { id: "p1", name: "Dra. Ana", active: true, sortOrder: 0, professionalServices: [], workingHours: [] },
            ]}
            isSupportImpersonation={true}
            defaultDialogOpen={true}
          />
        )
      );

      expect(html).toContain("data-testid=\"support-mode-badge\"");
      expect(html).toContain("data-help-key=\"catalogo.profissionalNome\"");
      expect(html).toContain("Paginação dos profissionais");
    });

    it("Profissional Detalhe exibe badge quando isSupportImpersonation=true e ajudas dos campos", () => {
      const html = renderToStaticMarkup(
        withProviders(
          <ProfessionalDetailClient
            tenantSlug="clinica-teste"
            professional={{ id: "p1", name: "Dra. Ana", active: true, sortOrder: 0, professionalServices: [], workingHours: [] }}
            allServices={[]}
            initialExceptions={[]}
            isSupportImpersonation={true}
          />
        )
      );

      expect(html).toContain("data-testid=\"support-mode-badge\"");
      expect(html).toContain("data-help-key=\"catalogo.profissionalNome\"");
      expect(html).toContain("data-help-key=\"catalogo.profissionalAtivo\"");
    });

    it("Bloqueios exibe badge quando isSupportImpersonation=true e ajuda nos campos do form", () => {
      const html = renderToStaticMarkup(
        withProviders(
          <BloqueiosClient
            tenantSlug="clinica-teste"
            timezone="America/Sao_Paulo"
            initialExceptions={[
              { id: "b1", type: "HOLIDAY", startsAt: "2026-12-25T00:00:00.000Z", endsAt: "2026-12-25T23:59:59.000Z", reason: "Natal" },
            ]}
            isSupportImpersonation={true}
            defaultDialogOpen={true}
          />
        )
      );

      expect(html).toContain("data-testid=\"support-mode-badge\"");
      expect(html).toContain("data-help-key=\"catalogo.bloqueioTipo\"");
      expect(html).toContain("data-help-key=\"catalogo.bloqueioPeriodo\"");
      expect(html).toContain("data-help-key=\"catalogo.bloqueioMotivo\"");
      expect(html).toContain("Paginação dos bloqueios e feriados");
    });

    it("Agendamentos exibe badge quando isSupportImpersonation=true e ajuda nos filtros", () => {
      const html = renderToStaticMarkup(
        withProviders(
          <AgendamentosClient
            tenantSlug="clinica-teste"
            timezone="America/Sao_Paulo"
            professionals={[]}
            services={[]}
            isSupportImpersonation={true}
          />
        )
      );

      expect(html).toContain("data-testid=\"support-mode-badge\"");
      expect(html).toContain("data-help-key=\"catalogo.agendamentosFiltros\"");
    });
  });

  describe("Paginação numerada nas listas de catálogo", () => {
    it("pagina itens de serviços corretamente (limita exibição a pageSize e exibe seletor)", () => {
      const items = Array.from({ length: 30 }, (_, i) => ({
        id: `s-${i + 1}`,
        name: `Serviço ${i + 1}`,
        durationMin: 30,
        bufferAfterMin: 0,
        priceCents: 1000,
        active: true,
        sortOrder: i,
      }));

      const html = renderToStaticMarkup(
        withProviders(
          <ServicosClient
            tenantSlug="clinica-teste"
            initialServices={items}
          />
        )
      );

      expect(html).toContain("Mostrando");
      expect(html).toContain("1");
      expect(html).toContain("25");
      expect(html).toContain("30");
      expect(html).toContain("Página 1 de 2");
      expect(html).toContain("Por página");
      expect(html).toContain("Serviço 1");
      expect(html).toContain("Serviço 25");
      expect(html).not.toContain("Serviço 26");
    });

    it("pagina itens de profissionais corretamente", () => {
      const items = Array.from({ length: 15 }, (_, i) => ({
        id: `p-${i + 1}`,
        name: `Profissional ${i + 1}`,
        active: true,
        sortOrder: i,
        professionalServices: [],
        workingHours: [],
      }));

      const html = renderToStaticMarkup(
        withProviders(
          <ProfissionaisClient
            tenantSlug="clinica-teste"
            initialProfessionals={items}
          />
        )
      );

      expect(html).toContain("Mostrando");
      expect(html).toContain("15");
      expect(html).toContain("Por página");
    });
  });
});
