import { cn } from "@/components/lib/cn";
import { APP_VERSION, BUILD_DATE, DESENVOLVEDORA, DESENVOLVEDORA_URL, VERSAO_EXIBIDA } from "@/lib/app-info";

/**
 * Selo da desenvolvedora, no rodapé da barra lateral dos painéis (tenant e admin) e da gaveta do celular.
 *
 * Antes era fixo no canto inferior direito da tela e cobria botões de ação (Salvar de Configurações,
 * "Avançar" do onboarding, o ⓘ do Início) — o dono reclamou. Na barra lateral fica sempre visível sem
 * sobrepor nada. Discreto: a SUPERFÍCIE fica translúcida em repouso e opaca no hover; o conteúdo
 * (texto/versão) nunca perde opacidade, para manter contraste AA. A área clicável tem no mínimo 44px.
 */
export function InnovareCodeBadge({ className }: { className?: string }) {
  return (
    <a
      href={DESENVOLVEDORA_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Desenvolvido por ${DESENVOLVEDORA}, versão ${APP_VERSION}`}
      title={`Desenvolvido por ${DESENVOLVEDORA} · ${VERSAO_EXIBIDA} (build ${BUILD_DATE})`}
      className={cn(
        "flex min-h-11 w-full items-center justify-center gap-2 rounded-hero bg-surface/80 px-2.5 py-1.5",
        "shadow-card ring-1 ring-border backdrop-blur-md transition-all",
        "hover:-translate-y-0.5 hover:bg-surface hover:shadow-card-hover",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        "motion-reduce:transition-none motion-reduce:hover:translate-y-0",
        className,
      )}
    >
      {/* <img> simples: PNG estático pequeno, sem otimização de imagem (mesma escolha do AuthShell). */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/innovarecode.png"
        alt=""
        aria-hidden="true"
        width={49}
        height={32}
        decoding="async"
        className="h-7 w-auto sm:h-8"
      />
      <span className="flex flex-col leading-none">
        <span className="whitespace-nowrap text-[9px] font-bold uppercase tracking-widest text-text-secondary">Desenvolvido por</span>
        <span className="mt-0.5 text-[11px] font-black tracking-tight text-text">{DESENVOLVEDORA}</span>
      </span>
      <span className="rounded-lg bg-bg px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-text-secondary ring-1 ring-border">
        {VERSAO_EXIBIDA}
      </span>
    </a>
  );
}
