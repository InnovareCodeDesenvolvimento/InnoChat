"use client";

import { createContext, useCallback, useContext, useState } from "react";
import * as RadixToast from "@radix-ui/react-toast";
import { CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { cn } from "@/components/lib/cn";

type ToastVariant = "success" | "error" | "info";
type ToastItem = { id: string; title: string; description?: string; variant: ToastVariant };

type ToastContextValue = {
  notify: (toast: Omit<ToastItem, "id">) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const VARIANT_ICON: Record<ToastVariant, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: XCircle,
  info: AlertTriangle,
};

const VARIANT_CLASS: Record<ToastVariant, string> = {
  success: "border-success/30 text-success",
  error: "border-danger/30 text-danger",
  info: "border-border text-text",
};

/**
 * Provider único para toda a árvore do painel/admin — monta o `Viewport` uma
 * vez. Use `useToast().notify(...)` em qualquer client component descendente.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const notify = useCallback((toast: Omit<ToastItem, "id">) => {
    const id = crypto.randomUUID();
    setItems((prev) => [...prev, { ...toast, id }]);
  }, []);

  const remove = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ notify }}>
      <RadixToast.Provider swipeDirection="right">
        {children}
        {items.map((item) => {
          const Icon = VARIANT_ICON[item.variant];
          return (
            <RadixToast.Root
              key={item.id}
              duration={5000}
              onOpenChange={(open) => !open && remove(item.id)}
              className={cn(
                "toast-root rounded-card border bg-surface p-4 shadow-card",
                "grid grid-cols-[auto_1fr] gap-3",
                VARIANT_CLASS[item.variant],
              )}
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
              <div>
                <RadixToast.Title className="text-sm font-medium text-text">{item.title}</RadixToast.Title>
                {item.description ? (
                  <RadixToast.Description className="mt-1 text-sm text-text-secondary">
                    {item.description}
                  </RadixToast.Description>
                ) : null}
              </div>
            </RadixToast.Root>
          );
        })}
        <RadixToast.Viewport className="fixed bottom-4 right-4 z-[100] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 outline-none" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast() precisa estar dentro de <ToastProvider>.");
  }
  return ctx;
}
