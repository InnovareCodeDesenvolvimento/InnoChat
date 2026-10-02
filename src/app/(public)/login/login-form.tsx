"use client";

import { useActionState, useState } from "react";
import { ArrowLeft, KeyRound, Lock, LogIn, Mail } from "lucide-react";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { AuthInput } from "@/components/public/auth-input";
import { AUTH_SUBMIT_CLASS, AuthTrust } from "@/components/public/auth-panel";
import { loginAction, verifyTwoFactorLoginAction, type LoginState, type TwoFactorLoginState } from "./actions";

const INITIAL_STATE: LoginState = { error: null };
const INITIAL_CODE_STATE: TwoFactorLoginState = { error: null };

/** Segundo passo: código do app (6 dígitos) ou de recuperação. O desafio vai num campo escondido. */
function TwoFactorStep({ challenge, onBack }: { challenge: string; onBack: () => void }) {
  const [state, formAction, isPending] = useActionState(verifyTwoFactorLoginAction, INITIAL_CODE_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="challenge" value={challenge} />
      <p className="text-sm text-text-secondary">
        Abra o app de verificação (Google Authenticator ou parecido) e digite o código de 6 dígitos. Sem o celular, use um dos seus códigos de recuperação.
      </p>
      {state.error ? <Alert variant="danger">{state.error}</Alert> : null}

      <Field label="Código de verificação" htmlFor="code" required hint="Exemplo: 123456 ou abcde-fghij">
        {(fieldProps) => (
          <AuthInput
            {...fieldProps}
            icon={KeyRound}
            type="text"
            name="code"
            inputMode="text"
            autoComplete="one-time-code"
            autoFocus
            required
            invalid={!!state.error}
          />
        )}
      </Field>

      <Button icon={LogIn} type="submit" size="lg" isLoading={isPending} className={AUTH_SUBMIT_CLASS} loadingText="Verificando…">
        Verificar e entrar
      </Button>
      <Button type="button" variant="ghost" icon={ArrowLeft} onClick={onBack}>
        Voltar
      </Button>
    </form>
  );
}

export function LoginForm({ forgotLink }: { forgotLink: React.ReactNode }) {
  const [state, formAction, isPending] = useActionState(loginAction, INITIAL_STATE);
  // Desafio que a pessoa abandonou ("Voltar"): some da tela sem precisar mexer no estado da action.
  const [dismissed, setDismissed] = useState<string | null>(null);

  if (state.challenge && state.challenge !== dismissed) {
    return <TwoFactorStep challenge={state.challenge} onBack={() => setDismissed(state.challenge ?? null)} />;
  }

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.error ? <Alert variant="danger">{state.error}</Alert> : null}

      <Field label="E-mail" htmlFor="email" required>
        {(fieldProps) => (
          <AuthInput
            {...fieldProps}
            icon={Mail}
            type="email"
            name="email"
            autoComplete="email"
            placeholder="voce@empresa.com.br"
            required
            invalid={!!state.error}
          />
        )}
      </Field>

      <Field label="Senha" htmlFor="password" required labelAction={forgotLink}>
        {(fieldProps) => (
          <AuthInput
            {...fieldProps}
            icon={Lock}
            type="password"
            name="password"
            autoComplete="current-password"
            required
            invalid={!!state.error}
          />
        )}
      </Field>

      <Button icon={LogIn} type="submit" size="lg" isLoading={isPending} className={AUTH_SUBMIT_CLASS} loadingText="Entrando…">
        Entrar
      </Button>
      <AuthTrust />
    </form>
  );
}
