"use server";

import { revalidatePath } from "next/cache";
import { updateTenantThemeAction } from "@/modules/tenant/actions";

export type SaveThemeState = { ok: boolean; message: string | null };

/**
 * Adaptador de formulário para `updateTenantThemeAction` (docs/contratos.md). A permissão
 * (só OWNER) e a validação do tema ficam na action de domínio; aqui só traduzimos o
 * `Result` em mensagem e revalidamos o layout do tenant, que é quem aplica o `data-theme`.
 */
export async function saveThemeAction(
  _prevState: SaveThemeState,
  formData: FormData,
): Promise<SaveThemeState> {
  const tenantSlug = String(formData.get("tenantSlug") ?? "");
  const result = await updateTenantThemeAction(tenantSlug, { theme: formData.get("theme") });

  if (!result.ok) {
    return {
      ok: false,
      message:
        result.error.code === "FORBIDDEN"
          ? "Só o dono da empresa pode trocar o tema."
          : "Não foi possível salvar o tema. Tente de novo.",
    };
  }

  revalidatePath(`/${tenantSlug}`, "layout");
  return { ok: true, message: "Tema salvo. Toda a equipe já vê o novo visual." };
}
