"use client";

import { useState, useTransition } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { regenerateInternalApiSecretAction } from "@/modules/platform/actions";

export function InternalSecretCard({ initialConfigured }: { initialConfigured: boolean }) {
  const { notify } = useToast();
  const [isPending, startTransition] = useTransition();
  const [configured, setConfigured] = useState(initialConfigured);
  const [secretDialogOpen, setSecretDialogOpen] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function handleRegenerateSecret() {
    startTransition(async () => {
      const result = await regenerateInternalApiSecretAction();
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível gerar o segredo", description: result.error.message });
        return;
      }
      setNewSecret(result.data.secret);
      setCopied(false);
      setSecretDialogOpen(true);
      setConfigured(true);
    });
  }

  async function copySecret() {
    if (!newSecret) return;
    await navigator.clipboard.writeText(newSecret);
    setCopied(true);
  }

  return (
    <>
      <Card id="internal-secret" className="rounded-hero">
        <CardHeader>
          <CardTitle>Segredo da API interna (n8n → painel)</CardTitle>
          <CardDescription>
            Usado pelo n8n para autenticar chamadas ao painel. Gerar um novo segredo invalida o anterior
            na hora. Depois, sincronize o n8n de novo.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <Badge variant={configured ? "success" : "neutral"}>
              {configured ? "Configurado" : "Não configurado"}
            </Badge>
          </div>
        </CardContent>
        <CardFooter>
          <Button variant="secondary" onClick={handleRegenerateSecret} isLoading={isPending}>
            <KeyRound className="h-4 w-4" aria-hidden="true" />
            {configured ? "Gerar novo segredo" : "Gerar segredo"}
          </Button>
        </CardFooter>
      </Card>

      <Dialog open={secretDialogOpen} onOpenChange={setSecretDialogOpen}>
        <DialogContent>
          <DialogHeader icon={KeyRound}>
            <DialogTitle>Segredo gerado</DialogTitle>
            <DialogDescription>
              Copie agora. Por segurança, ele não aparece de novo depois que você fechar esta janela.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex items-center gap-2 rounded-card border border-border bg-bg p-3">
            <code className="flex-1 overflow-x-auto whitespace-nowrap text-sm text-text">{newSecret}</code>
            <Button type="button" variant="ghost" size="icon" aria-label="Copiar segredo" onClick={copySecret}>
              {copied ? <Check className="h-4 w-4 text-success" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
            </Button>
          </div>
          <DialogFooter>
            <Button icon={Check} type="button" onClick={() => setSecretDialogOpen(false)}>
              Já copiei, fechar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
