import { useId } from "react";
import { Label } from "./label";
import { HelpButton } from "@/components/help/help-button";
import type { HelpKey } from "@/components/help/help-content";

export type FieldProps = {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  /** Ação alinhada à direita da linha do label (ex.: "Esqueci minha senha"). */
  labelAction?: React.ReactNode;
  /** Ajuda contextual ⓘ associada diretamente ao campo */
  helpKey?: HelpKey;
  children: (fieldProps: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => React.ReactNode;
};

/**
 * Associa `label`/hint/erro ao controle sem repetir `id`s à mão em cada tela.
 * `children` é uma render prop porque o controle real (Input, Select…)
 * precisa receber `id` + `aria-describedby`, e cada um tem uma prop diferente
 * para isso — aqui é só o contrato de acessibilidade, não o componente.
 */
export function Field({ label, htmlFor, hint, error, required, labelAction, helpKey, children }: FieldProps) {
  const autoId = useId();
  const id = htmlFor ?? autoId;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  const labelContent = (
    <span className="inline-flex items-center gap-1.5">
      <span>
        {label}
        {required ? <span className="text-danger"> *</span> : null}
      </span>
      {helpKey ? <HelpButton helpKey={helpKey} placement="inline" /> : null}
    </span>
  );

  return (
    <div>
      {labelAction ? (
        <div className="mb-2 flex items-center justify-between gap-3">
          <Label htmlFor={id} className="mb-0">
            {labelContent}
          </Label>
          {labelAction}
        </div>
      ) : (
        <Label htmlFor={id}>
          {labelContent}
        </Label>
      )}
      {children({ id, "aria-describedby": describedBy, "aria-invalid": !!error })}
      {hint && !error ? (
        <p id={hintId} className="mt-1.5 text-xs text-text-secondary">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
