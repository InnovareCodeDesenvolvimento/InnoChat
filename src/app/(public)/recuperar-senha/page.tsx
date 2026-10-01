import type { Metadata } from "next";
import { AuthShell } from "@/components/public/auth-shell";
import { RecuperarSenhaForm } from "./recuperar-senha-form";

export const metadata: Metadata = { title: "Recuperar senha · InnoChat" };

export default function RecuperarSenhaPage() {
  return (
    <AuthShell>
      <RecuperarSenhaForm />
    </AuthShell>
  );
}
