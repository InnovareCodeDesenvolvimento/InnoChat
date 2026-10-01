"use client";

import { navIconFor } from "@/components/shell/nav-items";
import { Check, X } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { createContactAction, updateContactAction } from "@/modules/contacts/actions";

export type ContactFormTarget = {
  id: string;
  name: string | null;
  phoneE164: string | null;
  source: "WHATSAPP" | "PANEL";
  notes: string | null;
};

type Props = {
  tenantSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Presente = edição de um cliente existente; ausente/`null` = cadastro novo. */
  contact?: ContactFormTarget | null;
  onSaved: (contactId: string) => void;
  /** `CONTACT_EXISTS` devolve o id do cliente já cadastrado — deixa o usuário ir direto pra ele. */
  onOpenExisting?: (contactId: string) => void;
};

/**
 * Dialog único para criar e editar cliente (Vega, contrato fixado pelo Atlas). Trata os dois
 * erros esperados do servidor: `CONTACT_EXISTS` (telefone já cadastrado — mostra o cliente
 * existente) e `PHONE_LOCKED` (telefone vindo do WhatsApp, nunca editável por aqui — o campo já
 * sai desabilitado quando `source === "WHATSAPP"`, mas o erro do servidor é a fonte de verdade).
 */
export function ContactFormDialog({ tenantSlug, open, onOpenChange, contact = null, onSaved, onOpenExisting }: Props) {
  const editing = !!contact;
  const phoneLocked = contact?.source === "WHATSAPP";

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [existingId, setExistingId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    const timeoutId = setTimeout(() => {
      setName(contact?.name ?? "");
      setPhone(contact?.phoneE164 ?? "");
      setNotes(contact?.notes ?? "");
      setError(null);
      setExistingId(null);
    }, 0);
    return () => clearTimeout(timeoutId);
  }, [open, contact]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setExistingId(null);

    if (!name.trim()) {
      setError("Informe o nome do cliente.");
      return;
    }
    if (!editing && !phone.trim()) {
      setError("Informe o telefone do cliente.");
      return;
    }

    startTransition(async () => {
      const result =
        editing && contact
          ? await updateContactAction(tenantSlug, contact.id, {
              name: name.trim(),
              phone: phoneLocked ? undefined : phone.trim() || undefined,
              notes: notes.trim() || undefined,
            })
          : await createContactAction(tenantSlug, {
              name: name.trim(),
              phone: phone.trim(),
              notes: notes.trim() || undefined,
            });

      if (!result.ok) {
        if (result.error.code === "CONTACT_EXISTS") {
          const details = result.error.details as { contactId?: string } | undefined;
          setExistingId(details?.contactId ?? null);
          setError("Já existe um cliente cadastrado com esse telefone.");
          return;
        }
        if (result.error.code === "PHONE_LOCKED") {
          setError("O telefone deste cliente veio do WhatsApp e não pode ser alterado por aqui.");
          return;
        }
        setError(result.error.message);
        return;
      }

      const savedId = editing && contact ? contact.id : (result.data as { id: string }).id;
      onSaved(savedId);
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader icon={navIconFor("clientes")}>
          <DialogTitle>{editing ? "Editar cliente" : "Novo cliente"}</DialogTitle>
          <DialogDescription>
            {editing ? "Atualize os dados do cliente." : "Cadastre um cliente para agendar por ele."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4">
          {error ? (
            <Alert variant="danger">
              {error}
              {existingId ? (
                <>
                  {" "}
                  <button
                    type="button"
                    className="font-medium underline underline-offset-2"
                    onClick={() => {
                      onOpenChange(false);
                      onOpenExisting?.(existingId);
                    }}
                  >
                    Abrir cliente existente
                  </button>
                </>
              ) : null}
            </Alert>
          ) : null}

          <Field label="Nome" required>
            {(fieldProps) => (
              <Input {...fieldProps} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
            )}
          </Field>

          <Field
            label="Telefone"
            required={!editing}
            hint={phoneLocked ? "Este telefone veio do WhatsApp e não pode ser alterado por aqui." : undefined}
          >
            {(fieldProps) => (
              <Input
                {...fieldProps}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+55 11 99999-9999"
                disabled={phoneLocked}
                required={!editing}
              />
            )}
          </Field>

          <Field label="Notas">
            {(fieldProps) => (
              <textarea
                {...fieldProps}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                maxLength={2000}
                className="w-full rounded-card border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              />
            )}
          </Field>

          <DialogFooter>
            <Button icon={X} type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button icon={Check} type="submit" isLoading={isPending}>
              {editing ? "Salvar" : "Criar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
