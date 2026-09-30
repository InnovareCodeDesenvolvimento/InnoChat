"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/components/lib/cn";
import { useToast } from "@/components/ui/toast";
import { InnoAnimated } from "@/components/onboarding/inno-animated";
import { navIconFor } from "@/components/shell/nav-items";
import { useSetAttendanceWaitingCount } from "@/components/notifications/notification-center-provider";
import { NovoAgendamentoDialog, type AgendaProfessional, type AgendaService } from "@/components/agenda/novo-agendamento-dialog";
import { AttendanceQueue, type QueueStatus } from "@/components/attendance/attendance-queue";
import { AttendanceConversation, type ConversationContact } from "@/components/attendance/attendance-conversation";
import { CloseAttendanceDialog } from "@/components/attendance/close-attendance-dialog";
import { initialTab, type AttendanceItem, type AttendanceTab } from "@/components/attendance/attendance-utils";
import { listAttendanceQueueAction } from "@/modules/attendance/actions";
import { getContactAction } from "@/modules/contacts/actions";

/** Mesmo intervalo do polling do painel nesta rota (`pollBaseInterval` em live-refresh.ts). */
const POLL_MS = 15_000;

/**
 * Tela Atendimento (estilo WhatsApp Web): fila à esquerda, conversa à direita; no celular a fila
 * ocupa a tela e a conversa abre por cima, com botão voltar. O cliente aberto vem da URL
 * (`?contato=<id>`), então o sino, o F5 e o botão voltar do navegador funcionam sem estado extra.
 * Atualiza sozinho a cada 15 s (aba visível): fila, badge do menu e a conversa aberta.
 */
export function AtendimentoClient({
  tenantSlug,
  timezone,
  writeBlocked,
  professionals,
  services,
  notifyClient = false,
}: {
  tenantSlug: string;
  timezone: string;
  notifyClient?: boolean;
  writeBlocked: boolean;
  professionals: AgendaProfessional[];
  services: AgendaService[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { notify } = useToast();
  const syncBadge = useSetAttendanceWaitingCount();
  const selectedId = searchParams.get("contato");

  const [items, setItems] = useState<AttendanceItem[]>([]);
  const [waitingCount, setWaitingCount] = useState(0);
  const [status, setStatus] = useState<QueueStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [tab, setTab] = useState<AttendanceTab>("waiting");
  const [tick, setTick] = useState(0);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [fallback, setFallback] = useState<{ id: string; name: string; phone: string | null } | null>(null);

  const tabChosenRef = useRef(false);
  const selectedRef = useRef(selectedId);
  const lastSelectedRef = useRef<string | null>(null);

  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  const loadQueue = useCallback(
    async (silent: boolean) => {
      if (!silent) {
        setStatus("loading");
        setErrorMessage(null);
      }
      try {
        const result = await listAttendanceQueueAction({ tenantSlug });
        if (!result.ok) {
          if (!silent) {
            setErrorMessage(result.error.message);
            setStatus("error");
          }
          return;
        }
        const list = result.data.items as AttendanceItem[];
        setItems(list);
        setWaitingCount(result.data.waitingCount);
        syncBadge(result.data.waitingCount);
        setStatus("ready");
        if (!tabChosenRef.current) {
          tabChosenRef.current = true;
          setTab(initialTab(list, selectedRef.current));
        }
      } catch {
        if (!silent) {
          setErrorMessage("Não deu para carregar a fila agora.");
          setStatus("error");
        }
      }
    },
    [tenantSlug, syncBadge],
  );

  // Carga inicial + polling de 15 s (só com a aba visível; volta a puxar na hora ao voltar para ela).
  useEffect(() => {
    const first = setTimeout(() => void loadQueue(false), 0);
    const pull = () => {
      if (document.visibilityState !== "visible") return;
      void loadQueue(true);
      setTick((t) => t + 1);
    };
    const id = setInterval(pull, POLL_MS);
    document.addEventListener("visibilitychange", pull);
    return () => {
      clearTimeout(first);
      clearInterval(id);
      document.removeEventListener("visibilitychange", pull);
    };
  }, [loadQueue]);

  const selectedItem = selectedId ? (items.find((i) => i.contactId === selectedId) ?? null) : null;

  // Dados do cliente aberto que a fila não traz: o telefone (aviso "receberá no WhatsApp" do Agendar) e, fora da
  // fila (ex.: link do sino de um atendimento antigo), o nome.
  useEffect(() => {
    if (!selectedId || status === "loading" || fallback?.id === selectedId) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const result = await getContactAction(tenantSlug, selectedId);
        if (cancelled) return;
        setFallback(
          result.ok
            ? { id: selectedId, name: result.data.displayName, phone: result.data.phoneE164 ?? null }
            : { id: selectedId, name: "Cliente", phone: null },
        );
      } catch {
        if (!cancelled) setFallback({ id: selectedId, name: "Cliente", phone: null });
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selectedId, status, fallback?.id, tenantSlug]);

  // Link do sino com a tela já aberta: leva a aba para onde o cliente está.
  useEffect(() => {
    if (!selectedId || selectedId === lastSelectedRef.current) return;
    if (!selectedItem) return;
    lastSelectedRef.current = selectedId;
    const timer = setTimeout(() => {
      tabChosenRef.current = true;
      setTab(initialTab(items, selectedId));
    }, 0);
    return () => clearTimeout(timer);
  }, [selectedId, selectedItem, items]);

  function select(contactId: string) {
    router.push(`${pathname}?contato=${encodeURIComponent(contactId)}`, { scroll: false });
  }

  function back() {
    router.replace(pathname, { scroll: false });
  }

  const contact: ConversationContact | null = selectedId
    ? {
        id: selectedId,
        name: selectedItem?.contactName ?? (fallback?.id === selectedId ? fallback.name : "Cliente"),
        item: selectedItem,
      }
    : null;
  const contactPhone = fallback?.id === selectedId ? fallback.phone : null;

  return (
    <div>
      <div className={cn(selectedId && "max-md:hidden")}>
        <PageHeader help="pagina.atendimento"
          icon={navIconFor("atendimento")}
          title="Atendimento"
          description="Responda pelo painel os clientes que pediram atendente."
        />
      </div>

      <div
        className={cn(
          "flex overflow-hidden rounded-hero border border-border bg-surface shadow-card",
          "h-[calc(100dvh-10rem)] min-h-[28rem] md:h-[calc(100dvh-17rem)] md:min-h-[32rem]",
        )}
        data-testid="attendance-layout"
      >
        <aside className={cn("flex min-h-0 w-full flex-col md:w-[22rem] md:shrink-0 md:border-r md:border-border", selectedId && "max-md:hidden")}>
          <AttendanceQueue
            items={items}
            waitingCount={waitingCount}
            status={status}
            errorMessage={errorMessage}
            tab={tab}
            onTabChange={(next) => {
              tabChosenRef.current = true;
              setTab(next);
            }}
            selectedContactId={selectedId}
            onSelect={select}
            onRetry={() => void loadQueue(false)}
          />
        </aside>

        <section className={cn("min-w-0 flex-1 flex-col", selectedId ? "flex" : "hidden md:flex")} aria-label="Conversa">
          {contact ? (
            <AttendanceConversation
              key={contact.id}
              tenantSlug={tenantSlug}
              contact={contact}
              timezone={timezone}
              refreshTick={tick}
              writeBlocked={writeBlocked}
              onBack={back}
              onSchedule={() => setScheduleOpen(true)}
              onClose={() => setCloseOpen(true)}
              onMessageSent={() => void loadQueue(true)}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center" data-testid="attendance-no-selection">
              <InnoAnimated variant="avatar" size={96} />
              <p className="font-display text-lg font-bold text-text">Escolha uma conversa</p>
              <p className="max-w-xs text-sm text-text-secondary">
                Selecione um cliente da fila para ler o histórico e responder pelo WhatsApp da empresa.
              </p>
            </div>
          )}
        </section>
      </div>

      {contact ? (
        <>
          <NovoAgendamentoDialog
            tenantSlug={tenantSlug}
            services={services}
            professionals={professionals}
            timezone={timezone}
            open={scheduleOpen}
            onOpenChange={setScheduleOpen}
            disabled={writeBlocked}
            presetContact={{ id: contact.id, name: contact.name, phone: contactPhone }}
            onCreated={() => void loadQueue(true)}
            notifyClient={notifyClient}
          />
          <CloseAttendanceDialog
            tenantSlug={tenantSlug}
            contactId={contact.id}
            contactName={contact.name}
            open={closeOpen}
            onOpenChange={setCloseOpen}
            onClosed={({ clientNotified }) => {
              notify({
                variant: "success",
                title: "Atendimento encerrado",
                description: clientNotified ? "O bot voltou a responder e o cliente foi avisado." : "O bot voltou a responder este cliente.",
              });
              void loadQueue(true);
              setTick((t) => t + 1);
              if (typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches) back();
            }}
          />
        </>
      ) : null}
    </div>
  );
}
