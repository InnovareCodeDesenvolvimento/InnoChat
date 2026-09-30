const MAX_TRAIL = 12;

/**
 * Empilha o estado em que se ENTROU (spec §2.5): máx. 12, sem repetir o topo. O topo da trilha
 * é sempre o estado atual.
 */
export function pushTrail(trail: string[] | undefined, state: string): string[] {
  const t = Array.isArray(trail) ? [...trail] : [];
  if (t[t.length - 1] === state) return t;
  t.push(state);
  return t.length > MAX_TRAIL ? t.slice(t.length - MAX_TRAIL) : t;
}

/**
 * "voltar": descarta o estado atual (topo) e devolve o anterior como destino. Trilha vazia
 * (ou só com o atual) → `MAIN_MENU`. `trail` devolvido já termina no destino, então reentrar
 * com `pushTrail` não duplica.
 */
export function popTrail(trail: string[] | undefined): { trail: string[]; target: string } {
  const t = Array.isArray(trail) ? [...trail] : [];
  t.pop();
  const target = t.length > 0 ? t[t.length - 1] : "MAIN_MENU";
  return { trail: t, target };
}
