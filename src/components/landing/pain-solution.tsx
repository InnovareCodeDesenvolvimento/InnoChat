import { ArrowDown, Check, X, Zap } from "lucide-react";
import { SectionHeading } from "./section-heading";

/** Estrutura DOR → SOLUÇÃO → RESOLUÇÃO. Só promessas que o código cumpre; nenhum número. */
const BLOCKS = [
  {
    pain: "Você larga o cliente que está na sua frente para responder WhatsApp o dia inteiro.",
    solution: "O bot responde e agenda sozinho, por um menu numerado fácil de usar.",
    result: "Você volta a atender quem está na cadeira, sem o celular na mão.",
  },
  {
    pain: "Mensagem fora do horário fica sem resposta e o cliente vai procurar o concorrente.",
    solution: "Resposta na hora, 24 horas por dia, inclusive à noite e no fim de semana.",
    result: "Quem chamou fora do expediente já pode sair com o horário marcado.",
  },
  {
    pain: "O cliente esquece, falta e deixa o horário vazio.",
    solution: "Lembrete automático no WhatsApp antes do horário, na antecedência que você escolher.",
    result: "Menos cadeira vazia: o cliente confirma, remarca ou cancela a tempo.",
  },
  {
    pain: "Você faz tudo sozinho, sem recepcionista.",
    solution: "O Inno atende, agenda e lembra. Quando o cliente pede um humano, ele chama a sua equipe.",
    result: "O Inno vira a sua recepcionista, de plantão o tempo todo.",
  },
];

export function PainSolution() {
  return (
    <section aria-labelledby="dor-titulo" className="bg-bg py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          id="dor-titulo"
          eyebrow="Da dor à solução"
          title="Marcar horário não precisa tomar o seu dia"
          description="Se o seu negócio vive de horário marcado, o WhatsApp vira uma segunda jornada de trabalho. Veja o que muda."
        />

        <ul className="mt-14 grid gap-6 md:grid-cols-2">
          {BLOCKS.map((block) => (
            <li
              key={block.pain}
              className="flex flex-col overflow-hidden rounded-hero border border-border bg-surface shadow-card transition-[box-shadow,border-color] duration-200 hover:border-primary/30 hover:shadow-card-hover"
            >
              <div className="flex items-start gap-3 bg-danger-bg/60 p-5 sm:p-6">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-danger text-white">
                  <X className="h-4 w-4" aria-hidden="true" />
                </span>
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-danger">A dor</p>
                  <p className="mt-1 text-base font-medium leading-snug text-text">{block.pain}</p>
                </div>
              </div>
              <div className="flex flex-1 items-start gap-3 p-5 sm:p-6">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-white">
                  <Zap className="h-4 w-4" aria-hidden="true" />
                </span>
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-primary">
                    <ArrowDown className="mr-1 inline h-3 w-3" aria-hidden="true" />A solução
                  </p>
                  <p className="mt-1 text-base leading-snug text-text">{block.solution}</p>
                </div>
              </div>
              <div className="mt-auto flex items-start gap-3 border-t border-border bg-success-bg/60 p-5 sm:p-6">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-success text-white">
                  <Check className="h-4 w-4" aria-hidden="true" />
                </span>
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-success">A resolução</p>
                  <p className="mt-1 text-base font-semibold leading-snug text-text">{block.result}</p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
