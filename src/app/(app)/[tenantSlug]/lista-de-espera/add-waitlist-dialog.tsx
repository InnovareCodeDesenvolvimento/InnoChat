"use client";

import { useEffect, useState, useTransition } from "react";
import { Hourglass, Search, UserPlus, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { formatPhoneDisplay } from "@/components/lib/format-phone";
import { parseMinute } from "@/core/waitlist/match";
import { listContactsAction } from "@/modules/contacts/actions";
import { addWaitlistEntryAction } from "@/modules/waitlist/actions";
import type { ProfessionalRow } from "../profissionais/profissionais-client";
import type { ServiceRow } from "../servicos/servicos-client";

type ContactHit = { id: string; name: string | null; phoneE164: string | null; pushName?: string | null };
type PeriodChoice = "ANY" | "MORNING" | "AFTERNOON" | "EVENING" | "RANGE";

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Adiciona alguém à lista de espera pelo painel: cliente cadastrado (busca) ou novo (nome e telefone), serviço, dia e horário desejado. */
export function AddWaitlistDialog(props: {
  tenantSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  services: ServiceRow[];
  professionals: ProfessionalRow[];
  onAdded: (alreadyExisted: boolean) => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        {/* O formulário só existe com o diálogo aberto: ao fechar, o estado some e a próxima abertura começa limpa. */}
        <AddWaitlistForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

function AddWaitlistForm({
  tenantSlug,
  onOpenChange,
  services,
  professionals,
  onAdded,
}: {
  tenantSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  services: ServiceRow[];
  professionals: ProfessionalRow[];
  onAdded: (alreadyExisted: boolean) => void;
}) {
  const activeServices = services.filter((s) => s.active);
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ContactHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<ContactHit | null>(null);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [serviceId, setServiceId] = useState(activeServices[0]?.id ?? "");
  const [professionalId, setProfessionalId] = useState("");
  const [date, setDate] = useState(todayISO());
  const [period, setPeriod] = useState<PeriodChoice>("ANY");
  const [rangeStart, setRangeStart] = useState("14:00");
  const [rangeEnd, setRangeEnd] = useState("17:00");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Busca de cliente com pequena espera (300 ms) depois de digitar.
  useEffect(() => {
    if (mode !== "existing" || query.trim().length < 2) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setSearching(true);
      listContactsAction(tenantSlug, { q: query.trim(), limit: 6 }).then((result) => {
        if (cancelled) return;
        setSearching(false);
        setHits(result.ok ? (result.data.items as ContactHit[]) : []);
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, mode, tenantSlug]);

  const eligibleProfessionals = professionals.filter((p) => p.active && (!serviceId || p.professionalServices.some((ps) => ps.serviceId === serviceId)));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === "existing" && !picked) {
      setError("Escolha o cliente na busca ou cadastre um novo.");
      return;
    }
    if (mode === "new" && (!newName.trim() || !newPhone.trim())) {
      setError("Informe o nome e o telefone do cliente. O telefone é por onde ele recebe o aviso.");
      return;
    }
    let windowStartMin: number | null = null;
    let windowEndMin: number | null = null;
    if (period === "RANGE") {
      windowStartMin = parseMinute(rangeStart);
      windowEndMin = parseMinute(rangeEnd);
      if (windowStartMin === null || windowEndMin === null || windowStartMin >= windowEndMin) {
        setError("A faixa de horário precisa começar antes de terminar.");
        return;
      }
    }
    startTransition(async () => {
      const result = await addWaitlistEntryAction(tenantSlug, {
        ...(mode === "existing" ? { contactId: picked?.id } : { newContact: { name: newName.trim(), phone: newPhone.trim() } }),
        serviceId,
        professionalId: professionalId || null,
        date,
        period: period === "RANGE" ? "ANY" : period,
        windowStartMin,
        windowEndMin,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      onAdded(result.data.alreadyExisted);
      onOpenChange(false);
    });
  }

  return (
    <>
        <DialogHeader icon={Hourglass}>
          <DialogTitle>Adicionar à lista de espera</DialogTitle>
          <DialogDescription>Quando abrir um horário que combine com o pedido, o cliente recebe um aviso no WhatsApp.</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
          {error ? <Alert variant="danger">{error}</Alert> : null}

          <div className="flex gap-2" role="group" aria-label="Cliente">
            <Button type="button" size="sm" variant={mode === "existing" ? "primary" : "secondary"} icon={Search} onClick={() => setMode("existing")} aria-pressed={mode === "existing"}>
              Cliente cadastrado
            </Button>
            <Button type="button" size="sm" variant={mode === "new" ? "primary" : "secondary"} icon={UserPlus} onClick={() => setMode("new")} aria-pressed={mode === "new"}>
              Novo cliente
            </Button>
          </div>

          {mode === "existing" ? (
            picked ? (
              <div className="flex items-center justify-between gap-2 rounded-card border border-border bg-bg p-3 text-sm">
                <div>
                  <p className="font-medium text-text">{picked.name ?? picked.pushName ?? "Sem nome"}</p>
                  {picked.phoneE164 ? <p className="text-text-secondary">{formatPhoneDisplay(picked.phoneE164)}</p> : null}
                </div>
                <Button type="button" size="sm" variant="ghost" icon={X} onClick={() => setPicked(null)}>
                  Trocar
                </Button>
              </div>
            ) : (
              <div>
                <Label htmlFor="wl-busca">Buscar cliente</Label>
                <Input id="wl-busca" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nome ou telefone" autoComplete="off" />
                {query.trim().length >= 2 ? (
                  <ul className="mt-2 flex flex-col gap-1" aria-label="Resultados da busca">
                    {(query.trim().length >= 2 ? hits : []).map((h) => (
                      <li key={h.id}>
                        <button
                          type="button"
                          onClick={() => setPicked(h)}
                          className="flex min-h-11 w-full flex-col items-start rounded-card border border-border px-3 py-2 text-left text-sm hover:bg-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                        >
                          <span className="font-medium text-text">{h.name ?? h.pushName ?? "Sem nome"}</span>
                          {h.phoneE164 ? <span className="text-text-secondary">{formatPhoneDisplay(h.phoneE164)}</span> : null}
                        </button>
                      </li>
                    ))}
                    {!searching && hits.length === 0 ? <li className="text-sm text-text-secondary">Ninguém encontrado. Use &quot;Novo cliente&quot;.</li> : null}
                  </ul>
                ) : null}
              </div>
            )
          ) : (
            <>
              <Field label="Nome do cliente" required>
                {(fieldProps) => <Input {...fieldProps} value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={120} />}
              </Field>
              <Field label="Telefone com DDD" required hint="É por onde o cliente recebe o aviso do horário.">
                {(fieldProps) => <Input {...fieldProps} value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="(11) 99999-9999" inputMode="tel" />}
              </Field>
            </>
          )}

          <div>
            <Label htmlFor="wl-servico">Serviço</Label>
            <Select
              id="wl-servico"
              value={serviceId}
              onChange={(e) => {
                setServiceId(e.target.value);
                setProfessionalId("");
              }}
              required
            >
              {activeServices.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.durationMin} min)
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="wl-prof">Profissional</Label>
            <Select id="wl-prof" value={professionalId} onChange={(e) => setProfessionalId(e.target.value)}>
              <option value="">Qualquer profissional</option>
              {eligibleProfessionals.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>

          <Field label="Dia que o cliente quer" required>
            {(fieldProps) => <Input {...fieldProps} type="date" min={todayISO()} value={date} onChange={(e) => setDate(e.target.value)} required />}
          </Field>

          <div>
            <Label htmlFor="wl-periodo">Horário</Label>
            <Select id="wl-periodo" value={period} onChange={(e) => setPeriod(e.target.value as PeriodChoice)}>
              <option value="ANY">Qualquer horário</option>
              <option value="MORNING">Manhã (antes das 12h)</option>
              <option value="AFTERNOON">Tarde (12h às 18h)</option>
              <option value="EVENING">Noite (a partir das 18h)</option>
              <option value="RANGE">Faixa de horário</option>
            </Select>
          </div>
          {period === "RANGE" ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="A partir de">{(fieldProps) => <Input {...fieldProps} type="time" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} />}</Field>
              <Field label="Até">{(fieldProps) => <Input {...fieldProps} type="time" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} />}</Field>
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="secondary" icon={X} onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" icon={Hourglass} isLoading={isPending} loadingText="Adicionando…" disabled={activeServices.length === 0}>
              Adicionar à lista
            </Button>
          </DialogFooter>
        </form>
    </>
  );
}
