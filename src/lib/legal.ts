import { DomainError } from "@/lib/errors";

/**
 * Versão vigente dos Termos de Uso e da Política de Privacidade — fonte única.
 *
 * `TERMS_VERSION` é enviada pelo formulário de cadastro e gravada pelo backend em
 * `termsVersion` (aceite versionado, docs/arquitetura.md §7.3 e §11). As páginas `/termos` e
 * `/privacidade` exibem o mesmo valor. Ao publicar uma nova redação:
 *   1. atualize o texto em `src/app/(public)/termos/termos-content.ts` e/ou
 *      `src/app/(public)/privacidade/privacidade-content.ts`;
 *   2. atualize o Markdown espelho em `docs/legal/`;
 *   3. troque `TERMS_VERSION` e `LEGAL_EFFECTIVE_DATE` aqui.
 *
 * Formato da versão: data ISO (`AAAA-MM-DD`) do dia em que a redação entra em vigor.
 */
export const TERMS_VERSION = "2026-10-01";

/** Data de vigência por extenso, para exibição. Mantenha em sincronia com `TERMS_VERSION`. */
export const LEGAL_EFFECTIVE_DATE = "1º de outubro de 2026";

/**
 * Confere a `termsVersion` que o cadastro público manda contra a versão vigente ANTES de
 * gravar o aceite (decisão do dono, 2026-09-29) — nunca confia no client sobre isso. Uma aba
 * antiga em cache mandaria a versão velha; gravar isso como aceite da versão nova seria uma
 * afirmação falsa (a pessoa nunca leu o texto atual). Lança `DomainError` com um código que a
 * tela consegue tratar ("atualize a página") em vez de aceitar silenciosamente ou sobrescrever
 * pela constante sem avisar — as outras duas opções fariam a pessoa "aceitar" um texto que
 * nunca viu.
 */
export function assertCurrentTermsVersion(version: string): void {
  if (version !== TERMS_VERSION) {
    throw new DomainError(
      "TERMS_VERSION_OUTDATED",
      "Os termos foram atualizados. Atualize a página e aceite os termos atuais para continuar.",
    );
  }
}
