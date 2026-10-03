import { getGoogleAuthConfigAction } from "@/modules/platform/actions";
import { GoogleLoginCard } from "@/components/admin/google-login-card";

export default async function ConfiguracoesLoginPage() {
  const google = await getGoogleAuthConfigAction();
  return (
    <div className="flex flex-col gap-6">
      <GoogleLoginCard initial={google.ok ? google.data : null} />
    </div>
  );
}
