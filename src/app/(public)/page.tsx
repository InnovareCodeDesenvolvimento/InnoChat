import type { Metadata } from "next";
import { Faq } from "@/components/landing/faq";
import { Features } from "@/components/landing/features";
import { FinalCta } from "@/components/landing/final-cta";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { LandingFooter } from "@/components/landing/landing-footer";
import { LandingHeader } from "@/components/landing/landing-header";
import { PainSolution } from "@/components/landing/pain-solution";
import { PanelShowcase } from "@/components/landing/panel-showcase";
import { Pricing } from "@/components/landing/pricing";
import { Segments } from "@/components/landing/segments";
import { SocialProof } from "@/components/landing/social-proof";
import { TRIAL_DAYS } from "@/core/billing";
import { SITE_URL } from "@/lib/site";
import { getLandingPlans } from "@/modules/billing/landing-plans";
import { getPublicLegalInfo } from "@/modules/platform/legal-service";

const TITLE = "InnoChat: agenda e atendimento no WhatsApp para quem vive de horário marcado";
const DESCRIPTION =
  `Seu WhatsApp agenda, remarca e cancela sozinho, 24 horas por dia, e lembra o cliente antes do horário. Teste grátis por ${TRIAL_DAYS} dias, sem cartão de crédito.`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: SITE_URL },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "InnoChat",
    locale: "pt_BR",
    title: TITLE,
    description: DESCRIPTION,
    images: [
      {
        url: "/landing/og.png",
        width: 1200,
        height: 630,
        alt: "InnoChat: seu WhatsApp agenda sozinho, 24 horas por dia, com o mascote Inno",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/landing/og.png"],
  },
};

/**
 * Renderizada a cada requisição: os planos vêm do banco e o build de produção roda SEM banco
 * (mesma regra de `/termos` e `/privacidade`). O custo é pequeno: `getLandingPlans` guarda o
 * resultado por 60 s em memória, e a página é quase toda Server Component (só o celular da hero
 * é Client Component). Se o banco falhar, a seção de planos mostra o convite sem preços.
 *
 * Sem redirecionamento para quem está logado: a home sempre foi a mesma para todos, e o
 * "Entrar" leva ao painel pela tela de login.
 */
export const dynamic = "force-dynamic";

async function readContactEmail(): Promise<string | null> {
  try {
    const info = await getPublicLegalInfo();
    return info.contactEmail?.trim() || null;
  } catch {
    return null;
  }
}

export default async function LandingPage() {
  const [plans, contactEmail] = await Promise.all([getLandingPlans(), readContactEmail()]);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "InnoChat",
    url: SITE_URL,
    description: DESCRIPTION,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    inLanguage: "pt-BR",
    publisher: { "@type": "Organization", name: "InnovareCode", url: "https://innovarecode.com.br" },
    ...(plans && plans.length > 0
      ? {
          offers: {
            "@type": "AggregateOffer",
            priceCurrency: "BRL",
            lowPrice: (Math.min(...plans.map((p) => p.priceCents)) / 100).toFixed(2),
            highPrice: (Math.max(...plans.map((p) => p.priceCents)) / 100).toFixed(2),
            offerCount: plans.length,
          },
        }
      : {}),
  };

  return (
    <div className="landing-root">
      <script
        type="application/ld+json"
        // JSON-LD próprio (sem entrada de usuário); `<` escapado para nunca fechar o <script>.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
      />
      <LandingHeader />
      <main>
        <Hero />
        <PainSolution />
        <HowItWorks />
        <Features />
        <PanelShowcase />
        <Segments />
        <SocialProof />
        <Pricing plans={plans} />
        <Faq />
        <FinalCta />
      </main>
      <LandingFooter contactEmail={contactEmail} />
    </div>
  );
}
