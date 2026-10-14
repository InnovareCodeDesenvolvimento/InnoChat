import type { Metadata } from "next";
import { headers } from "next/headers";
import { AuthShell } from "@/components/public/auth-shell";
import { Alert } from "@/components/ui/alert";
import { GoogleEntry } from "@/components/public/google-entry";
import { authErrorMessage } from "@/components/public/google-auth-errors";
import { MetaAutoTracking } from "@/components/public/meta-auto";
import { couponSummary, normalizeCouponCode } from "@/core/billing";
import { carriedQuery, detectInAppBrowser, externalBrowserHref } from "@/core/signup/in-app-browser";
import { getPublicAuthOptions } from "@/modules/auth/public-options";
import { checkRateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/http/client-ip";
import { getStoredPublicBaseUrl } from "@/lib/public-url";
import { getDefaultSignupPlan } from "@/modules/billing/service";
import { previewCoupon } from "@/modules/billing/coupons";
import { CadastroForm, type SignupCoupon } from "./cadastro-form";

export const metadata: Metadata = { title: "Criar conta · InnoChat" };

/**
 * Cupom que veio no link do anúncio (`/cadastro?cupom=CODIGO`). Lido aqui, no servidor: o rastreio
 * limpa a query no navegador. Inválido, vencido ou esgotado: a página segue sem selo e sem erro
 * (o motivo da recusa nunca sai por rota pública).
 */
async function couponFromLink(raw: string | undefined): Promise<SignupCoupon | null> {
  const code = raw ? normalizeCouponCode(raw.slice(0, 40)) : "";
  if (!code) return null;
  try {
    // Rota pública: o selo confirma que um código existe, então tem limite por IP (30 a cada 10 min). Estourou: sem selo, sem erro.
    if (!checkRateLimit(`signup-coupon-seal:${await clientIp()}`, 30, 10 * 60 * 1000).allowed) return null;
    const plan = await getDefaultSignupPlan();
    const preview = await previewCoupon({ code, planId: plan.id, cycle: "MONTHLY" });
    const { coupon } = preview;
    return { code: coupon.code, summary: couponSummary(coupon.kind, coupon.value, coupon.duration, coupon.durationCycles) };
  } catch {
    return null;
  }
}

/**
 * Host público para o link "abrir no navegador". Vem da URL pública gravada pelo admin (fonte confiável); o cabeçalho da
 * requisição só vale enquanto não há URL gravada (janela de instalação). Só aceita formato de domínio.
 */
async function publicHost(requestHeaders: Headers): Promise<string | null> {
  const stored = await getStoredPublicBaseUrl().catch(() => null);
  let host = "";
  if (stored) {
    try {
      host = new URL(stored).host;
    } catch {
      host = "";
    }
  }
  if (!host) host = (requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "").split(",")[0].trim();
  return /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? host : null;
}

type SearchParams = Record<string, string | string[] | undefined>;

export default async function CadastroPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const authError = authErrorMessage(typeof params.error === "string" ? params.error : undefined);
  const [coupon, requestHeaders, authOptions] = await Promise.all([
    couponFromLink(typeof params.cupom === "string" ? params.cupom : undefined),
    headers(),
    getPublicAuthOptions(),
  ]);
  // O Google recusa o login dentro do navegador do Instagram/Facebook (erro 403 disallowed_useragent).
  // Ali o botão do Google vira "Continuar com Google", que abre esta mesma página no navegador do sistema
  // (com cupom e parâmetros de campanha) e inicia o Google lá (`via=google`).
  const browser = detectInAppBrowser(requestHeaders.get("user-agent"));
  const host = await publicHost(requestHeaders);
  const googleExternalHref =
    browser.inApp && authOptions.google && host
      ? externalBrowserHref(browser.platform, host, "/cadastro", carriedQuery(params, { via: "google" }))
      : null;
  // Chegou pelo botão acima, já no navegador do sistema: o Google começa sozinho (a menos que tenha voltado dele com erro).
  const autoStartGoogle = !browser.inApp && params.via === "google" && !authError;
  return (
    <AuthShell formMaxWidth="max-w-2xl" compactMobileBrand topLink={{ prompt: "Já tem conta?", label: "Entrar", href: "/login" }}>
      <CadastroForm
        coupon={coupon}
        googleExternalHref={googleExternalHref}
        top={
          authError || !browser.inApp ? (
            <>
              {authError ? (
                <Alert variant="danger" title={authError.title}>
                  {authError.description}
                </Alert>
              ) : null}
              {browser.inApp ? null : <GoogleEntry label="Cadastrar com Google" coupon={coupon?.code} autoStart={autoStartGoogle} />}
            </>
          ) : undefined
        }
      />
      <MetaAutoTracking stripQuery />
    </AuthShell>
  );
}
