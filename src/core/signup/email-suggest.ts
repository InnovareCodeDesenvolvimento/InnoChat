/**
 * Sugestão de correção para e-mail digitado errado (só cliente, nunca bloqueia o cadastro).
 * Cobre os erros que mais aparecem no celular: letra trocada ou faltando no domínio e ".con" no fim.
 */

const KNOWN_DOMAINS = ["gmail.com", "hotmail.com", "outlook.com", "yahoo.com.br", "yahoo.com", "icloud.com", "live.com", "uol.com.br", "bol.com.br"];

const FIXED_TYPOS: Record<string, string> = {
  "gmial.com": "gmail.com",
  "gmai.com": "gmail.com",
  "gmail.con": "gmail.com",
  "gmail.co": "gmail.com",
  "gmail.com.br": "gmail.com",
  "gmail.cm": "gmail.com",
  "gmal.com": "gmail.com",
  "gnail.com": "gmail.com",
  "gamil.com": "gmail.com",
  "hotmial.com": "hotmail.com",
  "hotmai.com": "hotmail.com",
  "hotmail.con": "hotmail.com",
  "hotamil.com": "hotmail.com",
  "hotmil.com": "hotmail.com",
  "outlok.com": "outlook.com",
  "outloo.com": "outlook.com",
  "outlook.con": "outlook.com",
  "yaho.com": "yahoo.com",
  "yahoo.con": "yahoo.com",
  "yahoo.com.b": "yahoo.com.br",
  "yahoo.com.bt": "yahoo.com.br",
  "icloud.con": "icloud.com",
};

/** Distância de edição (inserção, remoção, troca e troca de letras vizinhas) — suficiente para domínios curtos. */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Devolve o e-mail corrigido, ou `null` quando está tudo certo (ou quando não dá para ter certeza). */
export function suggestEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (KNOWN_DOMAINS.includes(domain)) return null;
  const fixed = FIXED_TYPOS[domain];
  if (fixed) return `${local}@${fixed}`;
  // Domínio parecido com um conhecido (1 letra de diferença), só para os que têm nome longo o bastante.
  if (domain.length >= 8) {
    const near = KNOWN_DOMAINS.find((known) => editDistance(domain, known) === 1);
    if (near) return `${local}@${near}`;
  }
  return null;
}
