import { PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/alert";
import type { HelpKey } from "@/components/help/help-content";
import { navIconFor } from "@/components/shell/nav-items";
import { getMyAccountAction } from "@/modules/auth/account-actions";
import { MinhaContaForm } from "./minha-conta-form";

/** Corpo compartilhado de "Minha conta" (painel da empresa e admin da plataforma). */
export async function MinhaContaPage({ iconKey, help }: { iconKey: "minha-conta" | "admin/minha-conta"; help?: HelpKey }) {
  const result = await getMyAccountAction();
  return (
    <div>
      <PageHeader help={help} icon={navIconFor(iconKey)} title="Minha conta" description="Seu nome e o e-mail de acesso." />
      {result.ok ? (
        <MinhaContaForm initialName={result.data.name} email={result.data.email} />
      ) : (
        <Alert variant="danger" title="Não deu para carregar sua conta">
          {result.error.message} Recarregue a página para tentar de novo.
        </Alert>
      )}
    </div>
  );
}
