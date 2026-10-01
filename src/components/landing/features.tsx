import {
  BarChart3,
  BellRing,
  CalendarCheck,
  Headset,
  LogIn,
  MessageSquareText,
  Palette,
  QrCode,
  ShieldCheck,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/components/lib/cn";
import { SectionHeading } from "./section-heading";

type Feature = { icon: LucideIcon; title: string; description: string };

const HIGHLIGHTS: (Feature & { bullets: string[] })[] = [
  {
    icon: BellRing,
    title: "Menos faltas, com lembrete automático",
    description: "O InnoChat avisa o cliente no WhatsApp antes do horário, para o atendimento não virar uma cadeira vazia.",
    bullets: ["Você escolhe a antecedência, de 2 a 48 horas", "Enviado só entre 8h e 21h, nunca de madrugada", "O cliente remarca ou cancela respondendo no próprio WhatsApp"],
  },
  {
    icon: Headset,
    title: "Sua equipe entra só quando importa",
    description: "O cliente escolhe \"Falar com atendente\": o bot pausa, avisa a equipe e ela responde pelo painel.",
    bullets: ["Tela Atendimento no estilo WhatsApp Web", "Fila de quem está aguardando, com aviso no painel", "Ao encerrar, a conversa volta para o bot"],
  },
  {
    icon: MessageSquareText,
    title: "Cliente avisado sem você digitar",
    description: "Quando a sua equipe marca, remarca ou cancela alguém na agenda, o cliente recebe a mensagem no WhatsApp.",
    bullets: ["Sem ligar nem mandar mensagem à mão", "Texto no tom da sua empresa", "Vale para agendamento, remarcação e cancelamento"],
  },
];

const FEATURES: Feature[] = [
  {
    icon: CalendarCheck,
    title: "Agenda organizada por profissional",
    description: "Profissionais, serviços, expedientes, bloqueios e feriados. O bot só oferece horário que existe.",
  },
  {
    icon: BarChart3,
    title: "Saiba quanto o bot já agendou",
    description: "Veja a taxa de faltas, quanto foi agendado pelo bot e os próximos atendimentos.",
  },
  {
    icon: MessageSquareText,
    title: "Fale do jeito da sua marca",
    description: "Ajuste saudação, mensagens e rótulos para falar do jeito da sua marca.",
  },
  {
    icon: Palette,
    title: "Painel com a cara da sua empresa",
    description: "Três temas prontos: escolha o visual do painel da sua empresa.",
  },
  {
    icon: UsersRound,
    title: "Cada pessoa com o acesso certo",
    description: "Papéis de dono e de equipe, cada um com o acesso que precisa.",
  },
  {
    icon: ShieldCheck,
    title: "Seus dados só com você",
    description: "Cada empresa enxerga apenas os próprios dados, conforme a LGPD. Veja os Termos e a Privacidade.",
  },
  {
    icon: LogIn,
    title: "Entre com um clique",
    description: "Entre e crie a conta com um clique, sem decorar mais uma senha.",
  },
  {
    icon: QrCode,
    title: "Pague por Pix, sem cartão",
    description: "A mensalidade é paga por Pix, com QR Code e copia e cola direto no painel.",
  },
];

export function Features() {
  return (
    <section id="recursos" aria-labelledby="recursos-titulo" className="scroll-mt-20 bg-bg py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          id="recursos-titulo"
          eyebrow="Recursos"
          title="Recursos pensados pelo resultado que entregam"
          description="Do primeiro &ldquo;oi&rdquo; do cliente até o lembrete do dia anterior, o InnoChat cuida do caminho inteiro."
        />

        <div className="mt-14 grid gap-6 lg:grid-cols-3">
          {HIGHLIGHTS.map((feature, index) => (
            <article
              key={feature.title}
              className={cn(
                "group relative overflow-hidden rounded-hero border bg-surface p-6 shadow-card transition-[box-shadow,border-color,transform] duration-200 motion-safe:hover:-translate-y-1 hover:shadow-card-hover sm:p-8",
                index === 0 ? "border-primary/30" : "border-border hover:border-primary/30",
              )}
            >
              <span className="flex h-14 w-14 items-center justify-center rounded-hero bg-gradient-to-br from-primary to-primary-strong text-white shadow-lg shadow-primary/30 transition-transform duration-200 motion-safe:group-hover:scale-110">
                <feature.icon className="h-7 w-7" aria-hidden="true" />
              </span>
              <h3 className="mt-6 font-display text-xl font-bold leading-snug text-text">{feature.title}</h3>
              <p className="mt-3 text-base leading-relaxed text-text-secondary">{feature.description}</p>
              <ul className="mt-5 space-y-2.5 border-t border-border pt-5">
                {feature.bullets.map((bullet) => (
                  <li key={bullet} className="flex items-start gap-2.5 text-sm leading-snug text-text">
                    <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                    {bullet}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>

        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((feature) => (
            <li
              key={feature.title}
              className="group rounded-hero border border-border bg-surface p-5 shadow-card transition-[box-shadow,border-color] duration-200 hover:border-primary/30 hover:shadow-card-hover"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary transition-transform duration-200 motion-safe:group-hover:scale-110">
                <feature.icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <h3 className="mt-4 font-display text-base font-bold text-text">{feature.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">{feature.description}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
