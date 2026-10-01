"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ChatDoodle, ChatInputBar, HomeIndicator, PhoneFrame } from "@/components/whatsapp/phone-mockup";
import { DemoBubble, DemoChatHeader, DemoDayChip, startsRunAt } from "./demo-parts";
import type { DemoMessage } from "./demo-script";

const PHONE_WIDTH = 300;
const PHONE_HEIGHT = 560;
const TYPING_MS = 650;
const STAGGER_MS = 170;

/**
 * Celular da jornada. Mostra as `count` primeiras mensagens do roteiro.
 * - `animated` (palco fixo): quando `count` sobe, o cabeçalho mostra "digitando..." por um instante e
 *   as mensagens novas entram uma a uma; quando desce (a pessoa rolou de volta) troca na hora.
 * - estático (sequência vertical, reduced-motion, sem JS): só renderiza o recorte, sem relógio.
 * O tamanho é o do aparelho do hero (300x560), reduzido por CSS (`--jr-s`) em telas baixas.
 */
export function JourneyPhone({
  messages,
  count,
  company,
  animated,
  label,
}: {
  messages: DemoMessage[];
  count: number;
  company: string;
  animated: boolean;
  label: string;
}) {
  const [shown, setShown] = useState(count);
  const [freshFrom, setFreshFrom] = useState(Number.POSITIVE_INFINITY);
  const [typing, setTyping] = useState(false);
  const shownRef = useRef(count);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!animated) return;
    const timers: number[] = [];
    if (count > shownRef.current) {
      const from = shownRef.current;
      timers.push(window.setTimeout(() => setTyping(true), 0));
      timers.push(
        window.setTimeout(() => {
          shownRef.current = count;
          setTyping(false);
          setFreshFrom(from);
          setShown(count);
        }, TYPING_MS),
      );
    } else {
      timers.push(
        window.setTimeout(() => {
          shownRef.current = count;
          setTyping(false);
          setFreshFrom(Number.POSITIVE_INFINITY);
          setShown(count);
        }, 0),
      );
    }
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [count, animated]);

  const visible = animated ? shown : count;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: animated ? "smooth" : "auto" });
  }, [visible, animated]);

  const slice = messages.slice(0, visible);

  return (
    <div className="jr-phone-box" data-testid="journey-phone">
      <div>
        <PhoneFrame width={PHONE_WIDTH} height={PHONE_HEIGHT}>
          <div className="flex h-full flex-col bg-[var(--wa-bg)]">
            <DemoChatHeader company={company} typing={typing} />
            <div className="relative min-h-0 flex-1">
              <ChatDoodle />
              <div
                ref={scrollRef}
                tabIndex={0}
                role="region"
                aria-label={label}
                className="relative flex h-full flex-col overflow-y-auto px-2.5 py-2.5 [scrollbar-width:none] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--wa-header)] [&::-webkit-scrollbar]:hidden"
              >
                <div className="mt-auto flex flex-col gap-1.5">
                  <DemoDayChip />
                  {slice.map((message, index) => {
                    // Só as 3 últimas mensagens novas animam (as anteriores ficam acima da área visível).
                    const animFrom = Math.max(freshFrom, visible - 3);
                    const fresh = animated && index >= animFrom;
                    return (
                      <DemoBubble
                        key={message.id}
                        message={message}
                        startsRun={startsRunAt(messages, index)}
                        className={fresh ? "jr-msg-in" : undefined}
                        style={fresh ? ({ "--jr-d": `${(index - animFrom) * STAGGER_MS}ms` } as CSSProperties) : undefined}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
            <div aria-hidden="true">
              <ChatInputBar />
            </div>
            <HomeIndicator />
          </div>
        </PhoneFrame>
      </div>
    </div>
  );
}
