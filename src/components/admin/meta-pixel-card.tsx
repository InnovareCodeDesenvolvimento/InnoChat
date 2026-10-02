"use client";

import { useState } from "react";
import { Check, CheckCircle2, RefreshCw, Send, Trash2, X, XCircle } from "lucide-react";
import { cn } from "@/components/lib/cn";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { HelpButton } from "@/components/help/help-button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { isValidPixelId, normalizePixelId } from "@/core/meta/pixel";
import {
  getMetaConfigAction,
  removeMetaCapiTokenAction,
  saveMetaConfigAction,
  testMetaConfigAction,
} from "@/modules/meta/actions";

export type MetaPixelConfig = {
  enabled: boolean;
  pixelId: string | null;
  capiTokenSaved: boolean;
  testEventCode: string | null;
};

type Busy = "save" | "toggle" | "remove" | "test" | "reload" | null;

/** Admin > Configurações > Pixel do Meta: liga o Pixel nas páginas públicas e a Conversões (Purchase) pelo servidor. */
export function MetaPixelCard({ initial }: { initial: MetaPixelConfig | null }) {
  const { notify } = useToast();
  const [config, setConfig] = useState<MetaPixelConfig | null>(initial);
  const [pixelDraft, setPixelDraft] = useState<string | null>(null);
  const [tokenDraft, setTokenDraft] = useState("");
  const [codeDraft, setCodeDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; detalhe: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pixelError, setPixelError] = useState<string | null>(null);

  async function reload(): Promise<boolean> {
    try {
      const result = await getMetaConfigAction();
      if (result.ok) {
        setConfig(result.data);
        setLoadError(null);
        return true;
      }
      setLoadError(result.error.message);
    } catch {
      setLoadError("Falha de conexão ao carregar a configuração do Pixel.");
    }
    return false;
  }

  async function run(kind: "save" | "toggle" | "remove", fn: () => Promise<{ ok: boolean; error?: { message: string } }>, successTitle: string, after?: () => void) {
    setBusy(kind);
    try {
      const result = await fn();
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível concluir", description: result.error?.message });
        return;
      }
      after?.();
      await reload();
      notify({ variant: "success", title: successTitle });
    } catch {
      notify({ variant: "error", title: "Falha de conexão", description: "Tente de novo em instantes." });
    } finally {
      setBusy(null);
    }
  }

  if (!config) {
    return (
      <Card className="rounded-hero">
        <CardHeader>
          <CardTitle>Pixel do Meta</CardTitle>
          <CardDescription>Conta os visitantes e os cadastros que vêm dos seus anúncios.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-3">
          <Alert variant="danger" className="w-full">
            {loadError ?? "Não deu para carregar a configuração do Pixel."}
          </Alert>
          <Button
            icon={RefreshCw}
            type="button"
            variant="secondary"
            isLoading={busy === "reload"}
            onClick={async () => {
              setBusy("reload");
              await reload();
              setBusy(null);
            }}
          >
            Tentar de novo
          </Button>
        </CardContent>
      </Card>
    );
  }

  const pixelValue = pixelDraft ?? config.pixelId ?? "";
  const codeValue = codeDraft ?? config.testEventCode ?? "";
  const anyBusy = busy !== null;
  const canEnable = !!config.pixelId;

  function save() {
    const pixelId = normalizePixelId(pixelValue);
    const pixelChanged = pixelDraft !== null && pixelId !== (config?.pixelId ?? "");
    const token = tokenDraft.trim();
    const codeChanged = codeDraft !== null && codeDraft.trim() !== (config?.testEventCode ?? "");
    if (pixelChanged && !isValidPixelId(pixelId)) {
      setPixelError("O ID do Pixel tem só números, de 5 a 20 dígitos.");
      return;
    }
    setPixelError(null);
    if (!pixelChanged && !token && !codeChanged) {
      notify({ variant: "info", title: "Nada para salvar", description: "Em branco mantém o que já está salvo." });
      return;
    }
    void run(
      "save",
      () =>
        saveMetaConfigAction({
          ...(pixelChanged ? { pixelId } : {}),
          ...(token ? { capiToken: token } : {}),
          ...(codeChanged ? { testEventCode: codeDraft!.trim() } : {}),
        }),
      "Pixel do Meta salvo.",
      () => {
        setPixelDraft(null);
        setTokenDraft("");
        setCodeDraft(null);
        setTest(null);
      },
    );
  }

  async function runTest() {
    setTest(null);
    setBusy("test");
    try {
      const result = await testMetaConfigAction();
      setTest(result.ok ? { ok: result.data.ok, detalhe: result.data.detail } : { ok: false, detalhe: result.error.message });
    } catch {
      setTest({ ok: false, detalhe: "Falha de conexão ao testar. Tente de novo." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="rounded-hero" data-testid="meta-pixel-card">
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-[16rem] flex-1">
          <CardTitle className="flex items-center gap-2">
            Pixel do Meta
            <HelpButton helpKey="admin.pixelMeta" />
          </CardTitle>
          <CardDescription>
            Conta quem chega pelos anúncios, começa o cadastro, cria a conta e paga. Só na página inicial, nas páginas por tipo de negócio e no cadastro.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={config.enabled ? "success" : "neutral"}>{config.enabled ? "Ligado" : "Desligado"}</Badge>
          <Switch
            checked={config.enabled}
            onCheckedChange={(next) =>
              void run("toggle", () => saveMetaConfigAction({ enabled: next }), next ? "Pixel do Meta ligado." : "Pixel do Meta desligado.")
            }
            disabled={anyBusy || (!config.enabled && !canEnable)}
            aria-label="Pixel do Meta"
            aria-describedby="meta-enable-hint"
          />
        </div>
      </CardHeader>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        aria-label="Dados do Pixel do Meta"
      >
        <CardContent className="flex flex-col gap-4">
          <p id="meta-enable-hint" className={canEnable ? "sr-only" : "text-sm text-text-secondary"}>
            {canEnable ? "Liga ou desliga o Pixel e o aviso de cookies nas páginas públicas." : "Para ligar, salve o ID do Pixel primeiro."}
          </p>

          <Field label="ID do Pixel" hint="Só números. Fica no Gerenciador de Eventos, embaixo do nome do Pixel." error={pixelError ?? undefined}>
            {(fieldProps) => (
              <Input
                {...fieldProps}
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                value={pixelValue}
                onChange={(e) => setPixelDraft(e.target.value)}
                placeholder="1234567890123456"
              />
            )}
          </Field>

          <Field label="Chave de acesso da API de Conversões (token)" hint="Opcional. Sem ela só o navegador conta; com ela o pagamento também é enviado.">
            {(fieldProps) => (
              <div className="flex flex-col gap-2">
                <Input
                  {...fieldProps}
                  type="password"
                  autoComplete="off"
                  value={tokenDraft}
                  onChange={(e) => setTokenDraft(e.target.value)}
                  placeholder={config.capiTokenSaved ? "•••••••• (chave salva)" : "Não configurada"}
                />
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Badge variant={config.capiTokenSaved ? "success" : "neutral"}>{config.capiTokenSaved ? "Chave salva" : "Não configurada"}</Badge>
                  {config.capiTokenSaved ? (
                    <button
                      type="button"
                      onClick={() => setConfirmRemove(true)}
                      disabled={anyBusy}
                      className="min-h-11 rounded-card px-1 text-xs font-semibold text-danger underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50"
                    >
                      Remover chave salva
                    </button>
                  ) : null}
                </div>
              </div>
            )}
          </Field>

          <Field label="Código de teste (opcional)" hint="Do Gerenciador de Eventos, em Testar eventos. Só enquanto você confere; depois apague.">
            {(fieldProps) => (
              <Input
                {...fieldProps}
                autoComplete="off"
                spellCheck={false}
                value={codeValue}
                onChange={(e) => setCodeDraft(e.target.value)}
                placeholder="TEST12345"
              />
            )}
          </Field>

          {test ? (
            <p role="status" className={cn("flex items-start gap-1.5 text-sm", test.ok ? "text-success" : "text-danger")}>
              {test.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
              {test.detalhe}
            </p>
          ) : null}
        </CardContent>
        <CardFooter className="flex-wrap">
          <Button icon={Check} type="submit" isLoading={busy === "save"} loadingText="Salvando…" disabled={anyBusy && busy !== "save"}>
            Salvar Pixel
          </Button>
          <Button icon={Send} type="button" variant="secondary" onClick={runTest} isLoading={busy === "test"} loadingText="Enviando…" disabled={anyBusy && busy !== "test"}>
            Enviar evento de teste
          </Button>
        </CardFooter>
      </form>

      {/* Sempre montado: nunca dentro de condicional que a própria ação desmonta. */}
      <Dialog open={confirmRemove} onOpenChange={(open) => !open && busy === null && setConfirmRemove(false)}>
        <DialogContent>
          <DialogHeader icon={Trash2} tone="danger">
            <DialogTitle>Remover a chave de acesso?</DialogTitle>
            <DialogDescription>
              A chave salva será apagada do servidor. O Pixel do navegador continua, mas o pagamento deixa de ser enviado até você salvar outra chave.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button icon={X} type="button" variant="secondary" onClick={() => setConfirmRemove(false)} disabled={busy !== null}>
              Cancelar
            </Button>
            <Button
              icon={Trash2}
              type="button"
              variant="danger"
              isLoading={busy === "remove"}
              onClick={() =>
                void run("remove", () => removeMetaCapiTokenAction(), "Chave removida.", () => {
                  setConfirmRemove(false);
                  setTest(null);
                })
              }
            >
              Sim, remover
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
