import { DayStory } from "./day-story";

/**
 * "Você conhece esse dia": a dor contada como uma história real (linha do tempo com horários) e o
 * InnoChat como a virada, por um interruptor Sem/Com. Só comportamentos que o produto cumpre;
 * nenhum número de resultado. Detalhes em `day-story.tsx`.
 */
export function PainSolution() {
  return (
    <section aria-labelledby="dor-titulo" className="bg-bg py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <DayStory />
      </div>
    </section>
  );
}
