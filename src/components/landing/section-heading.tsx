import { cn } from "@/components/lib/cn";

/** Cabeçalho padrão de seção: etiqueta, h2 e parágrafo. `tone="dark"` para fundos escuros. */
export function SectionHeading({
  eyebrow,
  title,
  description,
  tone = "light",
  align = "center",
  id,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  tone?: "light" | "dark";
  align?: "center" | "left";
  id?: string;
}) {
  const dark = tone === "dark";
  return (
    <div className={cn("max-w-2xl", align === "center" && "mx-auto text-center")}>
      {eyebrow ? (
        <p
          className={cn(
            "text-xs font-bold uppercase tracking-[0.18em]",
            dark ? "text-accent" : "text-primary",
          )}
        >
          {eyebrow}
        </p>
      ) : null}
      <h2
        id={id}
        className={cn(
          eyebrow && "mt-3",
          "text-balance font-display text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl",
          dark ? "text-sidebar-active-text" : "text-text",
        )}
      >
        {title}
      </h2>
      {description ? (
        <p className={cn("mt-4 text-base leading-relaxed sm:text-lg", dark ? "text-sidebar-text" : "text-text-secondary")}>
          {description}
        </p>
      ) : null}
    </div>
  );
}
