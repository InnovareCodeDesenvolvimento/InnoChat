import { Activity, Brain, Hand, PawPrint, PenTool, Scissors, Smile, Sparkles, Stethoscope, Wand2, type LucideIcon } from "lucide-react";
import { SectionHeading } from "./section-heading";

const SEGMENTS: { icon: LucideIcon; label: string }[] = [
  { icon: Scissors, label: "Salões de beleza" },
  { icon: Wand2, label: "Barbearias" },
  { icon: Sparkles, label: "Estética" },
  { icon: Stethoscope, label: "Clínicas" },
  { icon: Smile, label: "Odontologia" },
  { icon: Activity, label: "Fisioterapia" },
  { icon: Brain, label: "Psicologia" },
  { icon: PawPrint, label: "Pet shops" },
  { icon: Hand, label: "Manicure" },
  { icon: PenTool, label: "Tatuagem" },
];

export function Segments() {
  return (
    <section aria-labelledby="segmentos-titulo" className="bg-surface py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          id="segmentos-titulo"
          eyebrow="Para quem é"
          title="Feito para quem vive de horário marcado"
          description="Se o seu cliente precisa marcar horário, ele pode fazer isso pelo WhatsApp."
        />

        <ul className="mt-14 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-5">
          {SEGMENTS.map((segment) => (
            <li
              key={segment.label}
              className="group flex flex-col items-center gap-3 rounded-hero border border-border bg-bg px-3 py-6 text-center shadow-card transition-[box-shadow,border-color,transform] duration-200 hover:border-primary/30 hover:shadow-card-hover motion-safe:hover:-translate-y-1"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary transition-transform duration-200 motion-safe:group-hover:scale-110">
                <segment.icon className="h-6 w-6" aria-hidden="true" />
              </span>
              <span className="font-display text-sm font-bold text-text sm:text-base">{segment.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
