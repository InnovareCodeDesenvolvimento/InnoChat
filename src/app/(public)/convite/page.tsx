import type { Metadata } from "next";
import { AuthShell } from "@/components/public/auth-shell";
import { GoogleInviteButton } from "@/components/public/google-invite-button";
import { getPublicAuthOptions } from "@/modules/auth/public-options";
import { ConviteForm } from "./convite-form";

export const metadata: Metadata = { title: "Aceitar convite · InnoChat" };

export default async function ConvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const googleEnabled = token ? (await getPublicAuthOptions()).google : false;
  return (
    <AuthShell>
      <ConviteForm token={token ?? null} top={googleEnabled && token ? <div className="mb-4"><GoogleInviteButton token={token} /></div> : null} />
    </AuthShell>
  );
}
