"use client";

import { CONSENT_REOPEN_EVENT } from "./meta-events";

/** Link do rodapé que reabre o banner de cookies (só existe quando o Pixel está ligado). */
export function ConsentReopenButton({ className }: { className?: string }) {
  return (
    <button type="button" className={className} onClick={() => window.dispatchEvent(new Event(CONSENT_REOPEN_EVENT))}>
      Preferências de cookies
    </button>
  );
}
