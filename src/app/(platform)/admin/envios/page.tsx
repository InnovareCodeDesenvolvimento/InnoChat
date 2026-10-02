import { Send } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { navIconFor } from "@/components/shell/nav-items";
import { listBillingNoticesAction } from "@/modules/billing/finance-actions";
import type { BillingNoticeFilters, NoticeChannel, NoticeStatus } from "@/components/admin/billing-types";
import { STEP_LABELS } from "@/core/billing/dunning-labels";
import type { DunningStep } from "@/core/billing/dunning-policy";
import { parsePageSize, parsePositiveInt } from "@/components/lib/pagination";
import { EnviosClient } from "./envios-client";

const CHANNELS: NoticeChannel[] = ["EMAIL", "WHATSAPP"];
const STATUSES: NoticeStatus[] = ["PENDING", "SENDING", "SENT", "FAILED", "SKIPPED"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type SearchParams = { tenantQuery?: string; channel?: string; status?: string; step?: string; from?: string; to?: string; falhas?: string; pagina?: string; porPagina?: string };

export default async function AdminEnviosPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const filters: BillingNoticeFilters = {
    tenantQuery: sp.tenantQuery?.trim().slice(0, 120) || undefined,
    channel: CHANNELS.find((c) => c === sp.channel),
    status: STATUSES.find((s) => s === sp.status),
    step: sp.step && sp.step in STEP_LABELS ? (sp.step as DunningStep) : undefined,
    from: sp.from && DATE_RE.test(sp.from) ? sp.from : undefined,
    to: sp.to && DATE_RE.test(sp.to) ? sp.to : undefined,
    onlyFailures: sp.falhas === "1" ? true : undefined,
  };

  const page = parsePositiveInt(sp.pagina, 1);
  const pageSize = parsePageSize(sp.porPagina);
  const result = await listBillingNoticesAction({ ...filters, page, pageSize });

  if (!result.ok) {
    return (
      <div>
        <PageHeader
          icon={navIconFor("admin/envios")}
          title="Envios de cobrança"
          description="Cada aviso mandado às empresas: para quem foi, por qual canal e se chegou."
          help="pagina.adminEnvios"
        />
        <EmptyState icon={Send} title="Não deu para carregar os envios" description={result.error.message} />
      </div>
    );
  }

  return <EnviosClient data={result.data} filters={filters} />;
}
