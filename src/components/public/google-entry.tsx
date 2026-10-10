import { GoogleButton, OrDivider } from "@/components/public/google-button";
import { getPublicAuthOptions } from "@/modules/auth/public-options";
import { signInWithGoogleAction } from "@/app/(public)/google-actions";

/**
 * Botão do Google + separador "ou", acima dos campos. Server Component: consulta as opções
 * públicas de login e some por completo quando o Google está desligado (ou se a consulta falhar —
 * o login por e-mail e senha nunca depende disto).
 */
export async function GoogleEntry({ label, coupon, autoStart }: { label: string; coupon?: string; autoStart?: boolean }) {
  let enabled = false;
  try {
    enabled = (await getPublicAuthOptions()).google;
  } catch {
    enabled = false;
  }
  if (!enabled) return null;
  return (
    <div className="flex flex-col gap-4">
      <GoogleButton label={label} action={signInWithGoogleAction} coupon={coupon} autoStart={autoStart} />
      <OrDivider />
    </div>
  );
}
