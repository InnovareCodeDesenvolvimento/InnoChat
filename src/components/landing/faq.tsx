import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { CANCEL_AFTER_SUSPENDED_TRIAL_DAYS, GRACE_DAYS, TRIAL_DAYS } from "@/core/billing";
import { SectionHeading } from "./section-heading";

type Faq = { question: string; answer: React.ReactNode };

/**
 * Perguntas frequentes. Cada resposta foi conferida contra o código: teste de TRIAL_DAYS dias sem
 * cartão (`cadastro-form`), fatura Pix do primeiro mês (`signup/service`), carência/suspensão/
 * cancelamento (`core/billing/status`), isolamento e LGPD (`/termos`, `/privacidade`). Os valores
 * dos planos NÃO aparecem aqui: ficam só na seção de planos, que lê do banco.
 */
const FAQS: Faq[] = [
  {
    question: "Quanto custa?",
    answer: (
      <>
        Os planos e os valores atuais estão na seção{" "}
        <a href="#planos" className="font-semibold text-primary underline underline-offset-4">
          Planos
        </a>
        . O pagamento é mensal, por Pix. E você começa com {TRIAL_DAYS} dias grátis, sem cartão de crédito.
      </>
    ),
  },
  {
    question: "Existe contrato ou fidelidade?",
    answer: (
      <>
        Não. Não há fidelidade nem multa: a cobrança é mensal, por Pix, e nenhum cartão fica salvo. Você pode
        cancelar quando quiser pela tela Assinatura do painel, e o cancelamento vale ao fim do período já pago.
        Os detalhes estão nos{" "}
        <Link href="/termos" className="font-semibold text-primary underline underline-offset-4">
          Termos de uso
        </Link>
        .
      </>
    ),
  },
  {
    question: "Preciso trocar de número ou comprar um chip novo?",
    answer:
      "Não. Você conecta o WhatsApp da sua empresa lendo um QR Code, como no WhatsApp Web, e seus clientes continuam conversando com o número que já conhecem. O cliente não precisa instalar nada.",
  },
  {
    question: "O que acontece depois dos 3 dias de teste?",
    answer: `Para continuar, você paga a primeira mensalidade por Pix, na tela de Assinatura do painel. Se o pagamento não for feito, há ${GRACE_DAYS} dia de carência; depois disso o painel fica somente leitura e o bot deixa de atender. Um teste que nunca foi pago é cancelado ${CANCEL_AFTER_SUSPENDED_TRIAL_DAYS} dias depois da suspensão.`,
  },
  {
    question: "O bot substitui a minha equipe?",
    answer:
      "Não. O bot cuida do trabalho repetitivo (agendar, remarcar, cancelar e lembrar). Quando o cliente pede \"Falar com atendente\", o bot pausa, a equipe é avisada e responde pelo painel, na tela Atendimento.",
  },
  {
    question: "Os dados da minha empresa e dos meus clientes ficam seguros?",
    answer: (
      <>
        Cada empresa enxerga somente os próprios dados, e o tratamento segue a LGPD. Os detalhes estão na{" "}
        <Link href="/privacidade" className="font-semibold text-primary underline underline-offset-4">
          Política de privacidade
        </Link>{" "}
        e nos{" "}
        <Link href="/termos" className="font-semibold text-primary underline underline-offset-4">
          Termos de uso
        </Link>
        .
      </>
    ),
  },
  {
    question: "Como faço para cancelar?",
    answer: (
      <>
        As regras de cancelamento e o que acontece com os dados depois dele estão descritas nos{" "}
        <Link href="/termos" className="font-semibold text-primary underline underline-offset-4">
          Termos de uso
        </Link>
        .
      </>
    ),
  },
];

/**
 * Accordion nativo (`<details>`/`<summary>`): abre e fecha com Enter e Espaço, tem foco visível
 * e é lido corretamente por leitores de tela, sem JavaScript. O atributo `name` agrupa os itens
 * (abrir um fecha o outro) nos navegadores que o suportam.
 */
export function Faq() {
  return (
    <section id="faq" aria-labelledby="faq-titulo" className="scroll-mt-20 bg-surface py-20 sm:py-28">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        <SectionHeading id="faq-titulo" eyebrow="Perguntas frequentes" title="Tire suas dúvidas antes de começar" />

        <div className="mt-12 space-y-3">
          {FAQS.map((faq) => (
            <details
              key={faq.question}
              name="faq"
              className="group rounded-hero border border-border bg-bg shadow-card transition-colors open:border-primary/30 open:bg-surface"
            >
              <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 rounded-hero px-5 py-3 text-left font-display text-base font-bold text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:px-6 [&::-webkit-details-marker]:hidden">
                {faq.question}
                <ChevronDown
                  className="h-5 w-5 shrink-0 text-primary transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
                  aria-hidden="true"
                />
              </summary>
              <div className="px-5 pb-5 text-base leading-relaxed text-text-secondary sm:px-6">{faq.answer}</div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
