import { redirect } from "next/navigation";
import { configTabHref, DEFAULT_CONFIG_TAB } from "./config-tabs";

/** `/admin/configuracoes` puro leva à aba padrão (Geral). */
export default function AdminConfiguracoesPage() {
  redirect(configTabHref(DEFAULT_CONFIG_TAB));
}
