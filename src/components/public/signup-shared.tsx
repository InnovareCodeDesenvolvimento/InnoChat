import Link from "next/link";

/** Aceite dos Termos de uso e da Política de privacidade (checkbox com 20px + rótulo clicável). */
export function TermsCheckbox({
  checked,
  onChange,
  error,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  error?: string;
}) {
  return (
    <div>
      <label className="flex items-start gap-3 rounded-card bg-bg/70 p-3 text-sm text-text ring-1 ring-border">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          aria-invalid={!!error || undefined}
          aria-describedby={error ? "acceptedTerms-error" : undefined}
          className="mt-0.5 h-5 w-5 shrink-0 rounded border-border accent-primary"
        />
        <span>
          Li e aceito os{" "}
          <Link href="/termos" target="_blank" className="text-primary hover:underline">
            Termos de uso
          </Link>{" "}
          e a{" "}
          <Link href="/privacidade" target="_blank" className="text-primary hover:underline">
            Política de privacidade
          </Link>
          .
        </span>
      </label>
      {error ? (
        <p id="acceptedTerms-error" role="alert" className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
