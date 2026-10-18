"use client";

import { useState } from "react";
import { Check, KeyRound, ShieldAlert, ShieldCheck, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { HelpButton } from "@/components/help/help-button";
import { formatTimeLabel } from "@/components/lib/format-date";
import { formatBytes } from "@/components/lib/format-bytes";
import { formatDateBR } from "@/modules/billing/format";
import type { ProbeBackupResult, ProbeKeyMode, RemoteBackupItem } from "@/modules/backup/restore-types";
import type { Result } from "@/lib/result";

// Importado sob demanda (não no topo do módulo): o arquivo "use server" carrega drivers pesados
// (AWS SDK, Google Drive) que não precisam entrar no bundle do cliente nem no grafo dos testes de
// componente — só quando o teste de integridade realmente é disparado.
async function defaultProbeAction(input: { ref: string; keyMode: ProbeKeyMode; customKeyHex?: string | null }) {
  const { probeBackupInspectAction } = await import("@/modules/backup/restore-actions");
  return probeBackupInspectAction(input);
}

const TZ = "America/Sao_Paulo";

type Phase = "idle" | "pending" | "success" | "error";

export type ProbeBackupDialogProps = {
  /** `null` enquanto o diálogo está fechado — o componente fica sempre montado; só `open` muda. */
  backup: RemoteBackupItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Injetável para teste; em produção é sempre `probeBackupInspectAction`. */
  probeAction?: (input: {
    ref: string;
    keyMode: ProbeKeyMode;
    customKeyHex?: string | null;
  }) => Promise<Result<ProbeBackupResult>>;
};

/**
 * Resumo legível do resultado do teste de integridade. Exportado separado do diálogo para dar
 * para testar os três desfechos (sucesso, chave errada, outro erro) sem precisar simular clique
 * nem `useState` — só passando `result`/`errorMessage` como prop.
 */
export function ProbeResultSummary({
  result,
  errorMessage,
  backupCreatedAt,
}: {
  result: ProbeBackupResult | null;
  errorMessage: string | null;
  /** ISO da coluna "Data de criação" da lista — o resultado do teste em si não traz essa data. */
  backupCreatedAt?: string | null;
}) {
  if (errorMessage) {
    return (
      <Alert variant="danger" title="O teste não conseguiu confirmar o backup">
        {errorMessage}
      </Alert>
    );
  }

  if (!result) return null;

  const createdAtDate = backupCreatedAt ? new Date(backupCreatedAt) : null;

  return (
    <div className="flex flex-col gap-3">
      <Alert variant="success" title="A chave abriu o arquivo e ele está inteiro">
        A leitura do conteúdo terminou sem erro. Nenhuma linha do banco de produção foi tocada.
      </Alert>
      <dl className="grid grid-cols-2 gap-3 rounded-card border border-border bg-bg p-4 text-sm">
        {createdAtDate ? (
          <div>
            <dt className="text-xs text-text-secondary">Data da cópia</dt>
            <dd className="font-medium tabular-nums text-text">
              {formatDateBR(createdAtDate, TZ)}, {formatTimeLabel(createdAtDate, TZ)}
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="text-xs text-text-secondary">Tabelas com dados</dt>
          <dd className="font-medium tabular-nums text-text">{result.tablesWithData}</dd>
        </div>
        <div>
          <dt className="text-xs text-text-secondary">Tamanho descompactado</dt>
          <dd className="font-medium tabular-nums text-text">{formatBytes(result.uncompressedSizeBytes)}</dd>
        </div>
        <div>
          <dt className="text-xs text-text-secondary">Impressão digital da chave</dt>
          <dd className="font-mono text-xs text-text">{result.fingerprint ?? "-"}</dd>
        </div>
        <div>
          <dt className="text-xs text-text-secondary">Chave usada</dt>
          <dd className="font-medium text-text">
            {result.matchesCurrentSystemKey ? "É a mesma chave salva hoje no sistema" : "É diferente da chave salva hoje no sistema"}
          </dd>
        </div>
      </dl>
      {result.warning ? <Alert variant="warning">{result.warning}</Alert> : null}
    </div>
  );
}

export function ProbeBackupDialog({ backup, open, onOpenChange, probeAction }: ProbeBackupDialogProps) {
  const [keyMode, setKeyMode] = useState<ProbeKeyMode>("SYSTEM");
  const [customKeyHex, setCustomKeyHex] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<ProbeBackupResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function resetForm() {
    setKeyMode("SYSTEM");
    setCustomKeyHex("");
    setPhase("idle");
    setResult(null);
    setErrorMessage(null);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) resetForm();
    onOpenChange(nextOpen);
  }

  async function handleSubmit() {
    if (!backup) return;
    setPhase("pending");
    setErrorMessage(null);
    const run = probeAction ?? defaultProbeAction;
    const res = await run({
      ref: backup.ref,
      keyMode,
      customKeyHex: keyMode === "CUSTOM" ? customKeyHex.trim() : null,
    });
    // A chave digitada nunca é guardada: some do estado assim que a resposta chega, com ou sem sucesso.
    setCustomKeyHex("");
    if (res.ok) {
      setResult(res.data);
      setPhase("success");
    } else {
      setErrorMessage(res.error.message);
      setPhase("error");
    }
  }

  const name = backup?.name ?? "";
  const isFinished = phase === "success" || phase === "error";
  const canSubmit = phase !== "pending" && (keyMode === "SYSTEM" || customKeyHex.trim().length > 0);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader icon={phase === "error" ? ShieldAlert : KeyRound} tone={phase === "error" ? "danger" : "primary"}>
          <div className="flex items-center gap-1.5">
            <DialogTitle>Testar integridade da cópia</DialogTitle>
            <HelpButton helpKey="backup.probeIntegridade" placement="inline" />
          </div>
          <DialogDescription>
            Vamos abrir <span className="font-medium text-text">{name}</span> com a chave escolhida e ler o
            conteúdo todo. Isso não altera nem restaura nada no banco de dados.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-5 flex flex-col gap-4">
          {!isFinished ? (
            <>
              <fieldset disabled={phase === "pending"}>
                <legend className="mb-2 text-sm font-medium text-text">Qual chave usar</legend>
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      { mode: "SYSTEM" as const, label: "A chave salva no sistema" },
                      { mode: "CUSTOM" as const, label: "Digitar uma chave antiga" },
                    ]
                  ).map((option) => {
                    const checked = keyMode === option.mode;
                    return (
                      <label
                        key={option.mode}
                        className={
                          "relative flex min-h-11 cursor-pointer items-center justify-center rounded-card border px-2 py-2 text-center text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-70 " +
                          (checked ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "border-border bg-surface hover:border-primary/40")
                        }
                      >
                        <input
                          type="radio"
                          name="probeKeyMode"
                          value={option.mode}
                          checked={checked}
                          onChange={() => setKeyMode(option.mode)}
                          className="sr-only"
                        />
                        <span className="inline-flex items-center gap-1.5 font-medium text-text">
                          {checked ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" /> : null}
                          {option.label}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              {keyMode === "CUSTOM" ? (
                <Field label="Chave antiga (hexadecimal)" hint="64 caracteres hexadecimais, com ou sem hífens. Nunca fica salva.">
                  {(fieldProps) => (
                    <Input
                      {...fieldProps}
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={phase === "pending"}
                      value={customKeyHex}
                      onChange={(e) => setCustomKeyHex(e.target.value)}
                      placeholder="a1b2c3d4-..."
                    />
                  )}
                </Field>
              ) : null}
            </>
          ) : (
            <ProbeResultSummary result={result} errorMessage={errorMessage} backupCreatedAt={backup?.createdAt} />
          )}
        </div>

        <DialogFooter>
          {isFinished ? (
            <>
              <Button type="button" variant="secondary" icon={X} onClick={resetForm}>
                Testar de novo
              </Button>
              <Button type="button" variant="primary" icon={Check} onClick={() => handleOpenChange(false)}>
                Fechar
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)} disabled={phase === "pending"}>
                Cancelar
              </Button>
              <Button
                type="button"
                variant="primary"
                icon={ShieldCheck}
                isLoading={phase === "pending"}
                loadingText="Testando..."
                disabled={!canSubmit}
                onClick={handleSubmit}
              >
                Rodar teste
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
