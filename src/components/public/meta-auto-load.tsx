"use client";

import { useEffect, useRef } from "react";
import { loadPixel, stripQueryFromLocation, trackPixel, writeConsent } from "./meta-events";

/**
 * Carrega o Pixel do Meta direto e marca `granted` no localStorage — sem banner
 * de consentimento. Usado em rotas onde a pergunta trava a conversão
 * (decisão do dono 2026-10-14: tela de /cadastro). `stripQuery` continua
 * valendo: a URL que vai para a Meta sai sem query (e-mail/nome/token).
 */
export function MetaAutoLoad({ pixelId, stripQuery = false }: { pixelId: string; stripQuery?: boolean }) {
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    writeConsent("granted");
    if (stripQuery) stripQueryFromLocation();
    loadPixel(pixelId);
    trackPixel("PageView");
  }, [pixelId, stripQuery]);

  return null;
}
