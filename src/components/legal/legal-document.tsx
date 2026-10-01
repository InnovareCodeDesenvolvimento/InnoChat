import Link from "next/link";
import { AppSignature } from "@/components/brand/app-signature";
import { Info } from "lucide-react";
import { LEGAL_EFFECTIVE_DATE, TERMS_VERSION } from "@/lib/legal";
import { fillLegalPlaceholders, type PlatformLegalInfo } from "@/core/legal/placeholders";

/**
 * Estrutura de um documento legal (Termos de Uso, Política de Privacidade).
 *
 * O texto vive em arquivos `.ts` ao lado de cada página (não em Markdown lido do disco em
 * runtime, que não viaja no build `standalone`). O Markdown espelho em `docs/legal/` é para
 * revisão jurídica e histórico.
 *
 * Marcação inline aceita nos textos: `**negrito**`, `` `código` `` e `[rótulo](/rota)` (só
 * links internos).
 */
export type LegalBlock =
  | string
  | { list: string[]; ordered?: boolean }
  | { subtitle: string; blocks: LegalBlock[] };

export type LegalSection = {
  /** Âncora (`#id`) usada no sumário. Só letras minúsculas, números e hífen. */
  id: string;
  title: string;
  blocks: LegalBlock[];
};

/**
 * Aplica `fillLegalPlaceholders` (domínio puro, `@/core/legal/placeholders`) recursivamente em
 * cada bloco de texto de uma seção — inclusive dentro de `{ list }` e `{ subtitle, blocks }`,
 * que também podem carregar marcadores como `[E-MAIL DE CONTATO]`. Chamado pelas páginas
 * `/termos` e `/privacidade` ANTES de passar `sections`/`intro` para `<LegalDocument>` — o
 * texto-fonte (`termos-content.ts`/`privacidade-content.ts`) nunca é editado, os marcadores
 * literais só existem ali.
 */
function fillBlock(block: LegalBlock, info: PlatformLegalInfo): LegalBlock {
  if (typeof block === "string") return fillLegalPlaceholders(block, info);
  if ("list" in block) return { ...block, list: block.list.map((item) => fillLegalPlaceholders(item, info)) };
  return { ...block, blocks: block.blocks.map((b) => fillBlock(b, info)) };
}

export function fillLegalSections(sections: LegalSection[], info: PlatformLegalInfo): LegalSection[] {
  return sections.map((section) => ({ ...section, blocks: section.blocks.map((b) => fillBlock(b, info)) }));
}

export function fillLegalIntro(intro: string[], info: PlatformLegalInfo): string[] {
  return intro.map((p) => fillLegalPlaceholders(p, info));
}

export type LegalDocumentProps = {
  title: string;
  intro: string[];
  sections: LegalSection[];
  /** Link cruzado para o outro documento, no rodapé. */
  related: { href: string; label: string };
};

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;

function renderInline(text: string): React.ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={i} className="rounded border border-border bg-surface px-1 py-0.5 font-mono text-[0.9em] text-text [overflow-wrap:anywhere]">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-text">
          {part.slice(2, -2)}
        </strong>
      );
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      return (
        <Link key={i} href={link[2]} className="font-medium text-primary underline underline-offset-2 hover:text-primary-strong">
          {link[1]}
        </Link>
      );
    }
    return part;
  });
}

function Block({ block, level }: { block: LegalBlock; level: 3 | 4 }) {
  if (typeof block === "string") {
    return <p>{renderInline(block)}</p>;
  }
  if ("list" in block) {
    const ListTag = block.ordered ? "ol" : "ul";
    return (
      <ListTag className={block.ordered ? "list-decimal space-y-1.5 pl-6" : "list-disc space-y-1.5 pl-6"}>
        {block.list.map((item, i) => (
          <li key={i} className="pl-1">
            {renderInline(item)}
          </li>
        ))}
      </ListTag>
    );
  }
  const Heading = level === 3 ? "h3" : "h4";
  return (
    <div className="space-y-3">
      <Heading className="pt-1 font-display text-base font-bold text-text">{block.subtitle}</Heading>
      {block.blocks.map((b, i) => (
        <Block key={i} block={b} level={4} />
      ))}
    </div>
  );
}

export function LegalDocument({ title, intro, sections, related }: LegalDocumentProps) {
  return (
    <div className="min-h-screen bg-bg">
      <header className="sticky top-0 z-10 border-b border-border bg-surface/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-[calc(70ch+3rem)] items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <Link href="/" className="font-display text-lg font-bold text-text">
            InnoChat
          </Link>
          <nav aria-label="Documentos legais" className="flex gap-4 text-sm">
            <Link href="/termos" className="text-text-secondary hover:text-primary">
              Termos
            </Link>
            <Link href="/privacidade" className="text-text-secondary hover:text-primary">
              Privacidade
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-[calc(70ch+3rem)] px-4 py-10 sm:px-6 sm:py-14">
        <h1 className="font-display text-[1.75rem] font-bold leading-tight text-text sm:text-4xl">{title}</h1>
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-text-secondary">
          <div className="flex gap-1.5">
            <dt>Vigência:</dt>
            <dd className="font-medium text-text">{LEGAL_EFFECTIVE_DATE}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt>Versão:</dt>
            <dd className="font-medium text-text">{TERMS_VERSION}</dd>
          </div>
        </dl>

        <div className="mt-6 space-y-4 text-base leading-relaxed text-text-secondary">
          {intro.map((p, i) => (
            <p key={i}>{renderInline(p)}</p>
          ))}
        </div>

        <nav aria-labelledby="sumario" className="mt-8 rounded-hero border border-border bg-surface p-5 shadow-card">
          <h2 id="sumario" className="font-display text-base font-bold text-text">
            Sumário
          </h2>
          <ol className="mt-3 space-y-1.5 text-sm">
            {sections.map((s, i) => (
              <li key={s.id} className="flex gap-2">
                <span className="w-6 shrink-0 text-right tabular-nums text-text-secondary">{i + 1}.</span>
                <a href={`#${s.id}`} className="text-primary hover:underline">
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="mt-10 space-y-10">
          {sections.map((s, i) => (
            <section key={s.id} id={s.id} aria-labelledby={`${s.id}-titulo`} className="scroll-mt-6">
              <h2 id={`${s.id}-titulo`} className="font-display text-xl font-bold text-text">
                {i + 1}. {s.title}
              </h2>
              <div className="mt-4 space-y-4 text-base leading-relaxed text-text-secondary [overflow-wrap:anywhere]">
                {s.blocks.map((b, j) => (
                  <Block key={j} block={b} level={3} />
                ))}
              </div>
              <p className="mt-4 text-right text-xs">
                <a href="#sumario" className="text-text-secondary hover:text-primary">
                  Voltar ao sumário
                </a>
              </p>
            </section>
          ))}
        </div>

        <footer className="mt-14 border-t border-border pt-6 text-sm text-text-secondary">
          <p>
            Versão {TERMS_VERSION}, em vigor desde {LEGAL_EFFECTIVE_DATE}. Veja também:{" "}
            <Link href={related.href} className="font-medium text-primary hover:underline">
              {related.label}
            </Link>
            .
          </p>
        </footer>
        <AppSignature className="mt-8 text-center" />
      </main>
    </div>
  );
}
