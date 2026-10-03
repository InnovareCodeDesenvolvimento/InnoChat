import { Settings } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

/** Falha ao carregar o dado de uma aba: o título e as abas continuam na tela (vêm do layout). */
export function ConfigLoadError({ message }: { message: string }) {
  return <EmptyState icon={Settings} title="Não deu para carregar" description={message} />;
}
