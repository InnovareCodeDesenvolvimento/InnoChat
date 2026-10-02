import type { Metadata } from "next";
import { Faq } from "@/components/landing/faq";
import { Features } from "@/components/landing/features";
import { FinalCta } from "@/components/landing/final-cta";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { LandingFooter } from "@/components/landing/landing-footer";
import { LandingHeader } from "@/components/landing/landing-header";
import { Pricing } from "@/components/landing/pricing";
import { SalesWhatsappButton } from "@/components/landing/sales-whatsapp-button";
import { MetaTracking } from "@/components/public/meta-tracking";
import { SITE_URL } from "@/lib/site";
import { getLandingPlans } from "@/modules/billing/landing-plans";
import { isGoogleAuthAvailable } from "@/modules/google-auth/config";
import { getPublicLegalInfo } from "@/modules/platform/legal-service";
import { getPublicSalesWhatsapp } from "@/modules/platform/sales-contact";
import { NicheLinks, NicheServices, NichePains } from "./niche-sections";
import { NICHES, type NicheSlug } from "./niches";

/** Metadata própria de cada página por tipo de negócio: título, descrição, canonical e Open Graph. */
export function nicheMetadata(slug: NicheSlug): Metadata {
  const niche = NICHES[slug];
  const url = `${SITE_URL}/${slug}`;
  return {
    metadataBase: new URL(SITE_URL),
    title: niche.metaTitle,
    description: niche.metaDescription,
    alternates: { canonical: url },
    openGraph: {
      type: "website",
      url,
      siteName: "InnoChat",
      locale: "pt_BR",
      title: niche.metaTitle,
      description: niche.metaDescription,
      images: [{ url: "/landing/og.png", width: 1200, height: 630, alt: niche.ogAlt }],
    },
    twitter: { card: "summary_large_image", title: niche.metaTitle, description: niche.metaDescription, images: ["/landing/og.png"] },
  };
}

async function readContactEmail(): Promise<string | null> {
  try {
    return (await getPublicLegalInfo()).contactEmail?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Página por tipo de negócio. Reaproveita as seções da landing (passos, recursos, planos, perguntas,
 * chamada final) e troca o que muda de um negócio para outro: hero com a conversa do bot do nicho,
 * dores do dia a dia, serviços de exemplo e perguntas específicas. Cada página que a usa precisa
 * declarar `export const dynamic = "force-dynamic"` (planos vêm do banco; o build roda sem banco).
 */
export async function NichePage({ slug }: { slug: NicheSlug }) {
  const niche = NICHES[slug];
  const [plans, contactEmail, salesWhatsapp, googleLogin] = await Promise.all([
    getLandingPlans(),
    readContactEmail(),
    getPublicSalesWhatsapp(),
    isGoogleAuthAvailable().catch(() => false),
  ]);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: niche.metaTitle,
    url: `${SITE_URL}/${slug}`,
    description: niche.metaDescription,
    inLanguage: "pt-BR",
    isPartOf: { "@type": "WebSite", name: "InnoChat", url: SITE_URL },
    about: { "@type": "SoftwareApplication", name: "InnoChat", applicationCategory: "BusinessApplication", operatingSystem: "Web" },
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
        <Hero niche={niche} />
        <NichePains niche={niche} />
        <NicheServices niche={niche} />
        <HowItWorks />
        <Features googleLogin={googleLogin} />
        <Pricing plans={plans} />
        <Faq extra={niche.faq} />
        <NicheLinks current={slug} />
        <FinalCta />
      </main>
      <LandingFooter contactEmail={contactEmail} />
      {salesWhatsapp ? <SalesWhatsappButton e164={salesWhatsapp.e164} display={salesWhatsapp.display} /> : null}
      <MetaTracking />
    </div>
  );
}
