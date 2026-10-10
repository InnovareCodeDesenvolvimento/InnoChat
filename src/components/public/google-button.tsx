"use client";

import { useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { cn } from "@/components/lib/cn";

const AUTO_START_KEY = "innochat:google-autostart";

/** Logo "G" multicolorido do Google (SVG inline, cores fixas exigidas pela marca). */
export function GoogleLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false" className={cn("h-5 w-5 shrink-0", className)}>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

export function GoogleSubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending || undefined}
      // Padrão de marca do Google (fundo branco, contorno neutro, texto escuro) — cores fixas
      // de propósito: o botão tem de ser idêntico em qualquer tema.
      className={cn(
        "inline-flex h-12 w-full items-center justify-center gap-3 rounded-card border border-[#747775] bg-white px-4",
        "text-base font-medium text-[#1f1f1f] transition-colors hover:bg-[#f2f2f2] active:bg-[#e8e8e8]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        "disabled:cursor-not-allowed disabled:opacity-70 motion-reduce:transition-none",
      )}
    >
      {pending ? (
        <Loader2 className="h-5 w-5 animate-spin text-[#1f1f1f] motion-reduce:animate-none" aria-hidden="true" />
      ) : (
        <GoogleLogo />
      )}
      <span>{pending ? "Abrindo o Google…" : label}</span>
    </button>
  );
}

/**
 * Botão "Entrar/Cadastrar com Google". É um `<form action>` para funcionar até sem JS: a Server
 * Action dispara `signIn("google")` e o Auth.js redireciona para o Google. Só renderize quando
 * `getPublicAuthOptions().google === true`.
 */
export function GoogleButton({
  label,
  action,
  coupon,
  autoStart = false,
}: {
  label: string;
  action: (formData: FormData) => Promise<void>;
  /** Cupom que veio no link do anúncio: viaja no formulário e o servidor guarda num cookie até a volta do Google. */
  coupon?: string;
  /**
   * Inicia o Google sozinho ao abrir a página (quem veio do navegador embutido do Instagram e tocou em
   * "Continuar com Google"). Uma vez por aba: sem isso, voltar do Google com erro reabriria o Google em laço.
   */
  autoStart?: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!autoStart) return;
    try {
      if (window.sessionStorage.getItem(AUTO_START_KEY)) return;
      window.sessionStorage.setItem(AUTO_START_KEY, "1");
    } catch {
      return; // sem sessionStorage não dá para garantir "uma vez só": não inicia sozinho, o botão continua ali.
    }
    // Sem cleanup de propósito: o StrictMode do dev roda o efeito duas vezes e o segundo passo já vê a marca.
    setTimeout(() => formRef.current?.requestSubmit(), 0);
  }, [autoStart]);
  return (
    <form action={action} ref={formRef}>
      {coupon ? <input type="hidden" name="coupon" value={coupon} /> : null}
      <GoogleSubmitButton label={label} />
    </form>
  );
}

/** Separador "ou" entre o botão do Google e os campos. */
export function OrDivider() {
  return (
    <div className="flex items-center gap-3 text-xs font-medium uppercase tracking-wide text-text-secondary" role="separator" aria-label="ou">
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      <span aria-hidden="true">ou</span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </div>
  );
}
