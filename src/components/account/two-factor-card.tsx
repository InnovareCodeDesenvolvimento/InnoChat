"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, Download, KeyRound, RefreshCw, ShieldCheck, ShieldOff } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import {
  beginTwoFactorSetupAction,
  disableTwoFactorAction,
  regenerateRecoveryCodesAction,
} from "@/modules/two-factor/actions";
import type { TwoFactorSetupStart, TwoFactorStatus } from "@/modules/two-factor/service";
import type { Result } from "@/lib/result";

/**
 * Confirma a ativação por `fetch` (rota, não Server Action): o servidor derruba as outras sessões e renova o cookie desta,
 * e uma action refaria a página com o cookie antigo (a pessoa cairia no login).
 */
async function confirmTwoFactorSetup(code: string): Promise<Result<{ recoveryCodes: string[] }>> {
  try {
    const response = await fetch("/api/two-factor/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    return (await response.json()) as Result<{ recoveryCodes: string[] }>;
  } catch {
    return { ok: false, error: { code: "NETWORK", message: "Não deu para falar com o servidor. Confira a conexão e tente de novo." } };
  }
}

type Step =
  | { kind: "idle" }
  | { kind: "setup"; start: TwoFactorSetupStart }
  | { kind: "codes"; codes: string[] }
  | { kind: "disable" }
  | { kind: "regenerate" };

/**
 * Verificação em 2 etapas na tela Minha conta (dono, equipe e admin). Ativar: QR (ou chave
 * manual) -> código do app -> 10 códigos de recuperação, mostrados UMA vez. Desativar e gerar
 * códigos novos pedem a senha ou um código. Com `forced` (admin sem 2FA) o card aparece sozinho
 * numa tela de bloqueio e some o "Desativar".
 */
export function TwoFactorCard({ status, forced = false }: { status: TwoFactorStatus; forced?: boolean }) {
  const router = useRouter();
  const { notify } = useToast();
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [usePassword, setUsePassword] = useState(false);
  const [isPending, startTransition] = useTransition();

  function reset() {
    setStep({ kind: "idle" });
    setError(null);
    setCode("");
    setPassword("");
    setUsePassword(false);
  }

  function begin() {
    setError(null);
    startTransition(async () => {
      const result = await beginTwoFactorSetupAction();
      if (!result.ok) return setError(result.error.message);
      setCode("");
      setStep({ kind: "setup", start: result.data });
    });
  }

  function confirm(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await confirmTwoFactorSetup(code);
      if (!result.ok) return setError(result.error.message);
      setCode("");
      setStep({ kind: "codes", codes: result.data.recoveryCodes });
    });
  }

  function proof() {
    return usePassword ? { password } : { code };
  }

  function submitDisable(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await disableTwoFactorAction(proof());
      if (!result.ok) return setError(result.error.message);
      reset();
      notify({ variant: "success", title: "Verificação em 2 etapas desativada." });
      router.refresh();
    });
  }

  function submitRegenerate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await regenerateRecoveryCodesAction(proof());
      if (!result.ok) return setError(result.error.message);
      setCode("");
      setPassword("");
      setStep({ kind: "codes", codes: result.data.recoveryCodes });
    });
  }

  function finishCodes() {
    reset();
    notify({ variant: "success", title: "Verificação em 2 etapas ativa." });
    router.refresh();
  }

  const proofField = (
    <>
      {usePassword ? (
        <Field label="Sua senha" htmlFor="tf-proof-password" required error={error}>
          {(fieldProps) => (
            <Input {...fieldProps} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} invalid={!!error} />
          )}
        </Field>
      ) : (
        <Field label="Código do app ou de recuperação" htmlFor="tf-proof-code" required error={error} hint="Exemplo: 123456 ou abcde-fghij">
          {(fieldProps) => (
            <Input {...fieldProps} inputMode="text" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} invalid={!!error} />
          )}
        </Field>
      )}
      {status.hasPassword ? (
        <button
          type="button"
          onClick={() => {
            setUsePassword((v) => !v);
            setError(null);
          }}
          className="self-start text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {usePassword ? "Usar um código no lugar" : "Usar a minha senha no lugar"}
        </button>
      ) : null}
    </>
  );

  return (
    <Card className="max-w-2xl rounded-hero" data-testid="two-factor-card">
      <CardHeader help="conta.doisFatores">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>Verificação em 2 etapas</CardTitle>
          {status.enabled ? <Badge variant="success">Ativada</Badge> : <Badge variant="neutral">Desativada</Badge>}
          {status.required ? <Badge variant="warning">Obrigatória</Badge> : null}
        </div>
        <CardDescription>
          Além da senha, o login pede um código de 6 dígitos que muda a cada 30 segundos, gerado no seu celular.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {forced && !status.enabled ? (
          <Alert variant="warning" title="Ative a verificação em 2 etapas para continuar">
            Contas de administrador da plataforma precisam dela. Leva dois minutos e você só faz uma vez.
          </Alert>
        ) : null}
        {error && step.kind === "idle" ? <Alert variant="danger">{error}</Alert> : null}

        {step.kind === "idle" && !status.enabled ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text-secondary">
              Você vai precisar de um app como Google Authenticator, Microsoft Authenticator ou Authy no celular.
            </p>
            <div>
              <Button icon={ShieldCheck} onClick={begin} isLoading={isPending} loadingText="Preparando…">
                Ativar verificação em 2 etapas
              </Button>
            </div>
          </div>
        ) : null}

        {step.kind === "setup" ? (
          <form onSubmit={confirm} className="flex flex-col gap-4" noValidate>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-text-secondary">
              <li>Abra o app de verificação e escolha adicionar uma conta.</li>
              <li>Leia o QR code abaixo. Se não der, digite a chave.</li>
              <li>Digite aqui o código de 6 dígitos que o app mostrar.</li>
            </ol>
            <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
              {/* eslint-disable-next-line @next/next/no-img-element -- QR gerado em runtime (data URL) */}
              <img
                src={step.start.qrDataUrl}
                alt="QR code para o app de verificação"
                width={176}
                height={176}
                className="h-44 w-44 shrink-0 rounded-card border border-border bg-white p-2"
              />
              <div className="min-w-0">
                <p className="text-xs text-text-secondary">Chave para digitar à mão</p>
                <p className="mt-1 break-all font-mono text-sm font-semibold tracking-wider text-text" data-testid="two-factor-secret">
                  {step.start.secretFormatted}
                </p>
              </div>
            </div>
            <Field label="Código do app" htmlFor="tf-confirm-code" required error={error} hint="Exemplo: 123456">
              {(fieldProps) => (
                <Input {...fieldProps} inputMode="numeric" autoComplete="one-time-code" maxLength={10} value={code} onChange={(e) => setCode(e.target.value)} invalid={!!error} />
              )}
            </Field>
            <div className="flex flex-wrap justify-end gap-3">
              <Button type="button" variant="ghost" onClick={reset}>
                Cancelar
              </Button>
              <Button type="submit" icon={ShieldCheck} isLoading={isPending} loadingText="Conferindo…">
                Confirmar e ativar
              </Button>
            </div>
          </form>
        ) : null}

        {step.kind === "codes" ? <RecoveryCodes codes={step.codes} onDone={finishCodes} /> : null}

        {step.kind === "idle" && status.enabled ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text-secondary">
              {status.recoveryCodesLeft > 0
                ? `Você tem ${status.recoveryCodesLeft} ${status.recoveryCodesLeft === 1 ? "código de recuperação" : "códigos de recuperação"} sem uso.`
                : "Seus códigos de recuperação acabaram. Gere novos para não ficar sem acesso se perder o celular."}
            </p>
            <div className="flex flex-wrap gap-3">
              <Button
                variant="secondary"
                icon={RefreshCw}
                onClick={() => {
                  reset();
                  setStep({ kind: "regenerate" });
                }}
              >
                Gerar novos códigos
              </Button>
              {status.required ? null : (
                <Button
                  variant="outline"
                  icon={ShieldOff}
                  onClick={() => {
                    reset();
                    setStep({ kind: "disable" });
                  }}
                >
                  Desativar
                </Button>
              )}
            </div>
            {status.required ? (
              <p className="text-xs text-text-secondary">Nesta conta a verificação é obrigatória, então não dá para desativar.</p>
            ) : null}
          </div>
        ) : null}

        {step.kind === "disable" ? (
          <form onSubmit={submitDisable} className="flex flex-col gap-4" noValidate>
            <Alert variant="warning">Sem a verificação em 2 etapas, só a senha protege a sua conta.</Alert>
            {proofField}
            <div className="flex flex-wrap justify-end gap-3">
              <Button type="button" variant="ghost" onClick={reset}>
                Cancelar
              </Button>
              <Button type="submit" variant="danger" icon={ShieldOff} isLoading={isPending} loadingText="Desativando…">
                Desativar verificação
              </Button>
            </div>
          </form>
        ) : null}

        {step.kind === "regenerate" ? (
          <form onSubmit={submitRegenerate} className="flex flex-col gap-4" noValidate>
            <p className="text-sm text-text-secondary">Os códigos antigos deixam de valer assim que você gerar os novos.</p>
            {proofField}
            <div className="flex flex-wrap justify-end gap-3">
              <Button type="button" variant="ghost" onClick={reset}>
                Cancelar
              </Button>
              <Button type="submit" icon={KeyRound} isLoading={isPending} loadingText="Gerando…">
                Gerar novos códigos
              </Button>
            </div>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { notify } = useToast();
  const text = codes.join("\n");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      notify({ variant: "success", title: "Códigos copiados." });
    } catch {
      notify({ variant: "error", title: "Não deu para copiar. Selecione e copie à mão." });
    }
  }

  function download() {
    const blob = new Blob([`Códigos de recuperação do InnoChat\n\n${text}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "innochat-codigos-de-recuperacao.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-4" data-testid="recovery-codes">
      <Alert variant="warning" title="Guarde estes códigos agora">
        Eles aparecem só desta vez. Cada um vale uma única vez e serve se você perder o celular.
      </Alert>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {codes.map((c) => (
          <li key={c} className="rounded-card border border-border bg-bg px-3 py-2 font-mono text-sm font-semibold tracking-wider text-text">
            {c}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="secondary" icon={Copy} onClick={copy}>
          Copiar
        </Button>
        <Button type="button" variant="secondary" icon={Download} onClick={download}>
          Baixar arquivo
        </Button>
      </div>
      <div className="flex justify-end">
        <Button type="button" onClick={onDone}>
          Já guardei, concluir
        </Button>
      </div>
    </div>
  );
}
