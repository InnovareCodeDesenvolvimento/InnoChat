import { PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/alert";
import type { HelpKey } from "@/components/help/help-content";
import { navIconFor } from "@/components/shell/nav-items";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { TwoFactorResetList } from "@/components/admin/two-factor-reset-list";
import { getMyAccountAction } from "@/modules/auth/account-actions";
import { getMyTwoFactorStatusAction, listOtherAdminsTwoFactorAction } from "@/modules/two-factor/actions";
import { MinhaContaForm } from "./minha-conta-form";
import { TwoFactorCard } from "./two-factor-card";

/** Corpo compartilhado de "Minha conta" (painel da empresa e admin da plataforma). */
export async function MinhaContaPage({ iconKey, help }: { iconKey: "minha-conta" | "admin/minha-conta"; help?: HelpKey }) {
  const isAdminArea = iconKey === "admin/minha-conta";
  const [result, twoFactor, otherAdmins] = await Promise.all([
    getMyAccountAction(),
    getMyTwoFactorStatusAction(),
    isAdminArea ? listOtherAdminsTwoFactorAction() : Promise.resolve(null),
  ]);
  return (
    <div>
      <PageHeader help={help} icon={navIconFor(iconKey)} title="Minha conta" description="Seu nome, o e-mail de acesso e a segurança do login." />
      <div className="flex flex-col gap-6">
        {result.ok ? (
          <MinhaContaForm initialName={result.data.name} email={result.data.email} />
        ) : (
          <Alert variant="danger" title="Não deu para carregar sua conta">
            {result.error.message} Recarregue a página para tentar de novo.
          </Alert>
        )}
        {twoFactor.ok ? <TwoFactorCard status={twoFactor.data} /> : null}
        {otherAdmins?.ok ? (
          <Card className="max-w-2xl rounded-hero">
            <CardHeader help="admin.doisFatores">
              <CardTitle>Outros administradores</CardTitle>
              <CardDescription>Quem perdeu o celular e os códigos pode ter a verificação em 2 etapas redefinida aqui.</CardDescription>
            </CardHeader>
            <TwoFactorResetList rows={otherAdmins.data} emptyText="Você é o único administrador da plataforma." />
          </Card>
        ) : null}
      </div>
    </div>
  );
}
