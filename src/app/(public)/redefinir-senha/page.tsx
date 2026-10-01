import type { Metadata } from "next";
import { AuthShell } from "@/components/public/auth-shell";
import { RedefinirSenhaForm } from "./redefinir-senha-form";

export const metadata: Metadata = { title: "Redefinir senha · InnoChat" };

export default async function RedefinirSenhaPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return (
    <AuthShell>
      <RedefinirSenhaForm token={token ?? null} />
    </AuthShell>
  );
}
