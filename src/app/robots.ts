import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/** Só as páginas públicas de marketing/entrada são indexáveis; painel e admin ficam fora. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/salao", "/barbearia", "/clinica-estetica", "/consultorio", "/pet-shop", "/cadastro", "/login", "/termos", "/privacidade"],
      disallow: ["/admin", "/api/"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
