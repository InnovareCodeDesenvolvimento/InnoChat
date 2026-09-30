import { cn } from "@/components/lib/cn";
import { HelpButton } from "@/components/help/help-button";
import type { HelpKey } from "@/components/help/help-content";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-card border border-border bg-surface shadow-card",
        className,
      )}
      {...props}
    />
  );
}

/**
 * `help` põe o "i" de ajuda (texto em `help/help-content.ts`) no canto superior direito do card e
 * reserva a faixa dele (`pr-14`) para não encostar no título nem no `Badge` ao lado do título.
 */
export function CardHeader({
  className,
  help,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { help?: HelpKey }) {
  return (
    <div className={cn("border-b border-border p-5", help && "relative pr-14", className)} {...props}>
      {children}
      {help ? <HelpButton helpKey={help} placement="corner" className="right-2 top-3" /> : null}
    </div>
  );
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("font-display text-lg font-bold text-text", className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("mt-1 text-sm text-text-secondary", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("flex items-center gap-3 border-t border-border p-5", className)} {...props} />
  );
}
