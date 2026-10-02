/**
 * Redação de dado pessoal e segredo em texto de erro (mensagem, stack, contexto) ANTES de gravar.
 * Regra do monitor de erros: o banco nunca guarda e-mail, telefone, CPF/CNPJ, token, senha nem URL com credencial.
 * Puro (sem Node/Next/Prisma): roda igual no servidor e nos testes.
 */

const SENSITIVE_KEY_WORDS =
  "password|passwd|senha|secret|token|api[_-]?key|apikey|authorization|cookie|set-cookie|session|sessionid|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key";

/** Chaves de objeto cujo valor nunca vai para o contexto. */
export const SENSITIVE_KEY_RE = new RegExp(`(${SENSITIVE_KEY_WORDS}|message|text|body|email|phone|telefone|cpf|cnpj|name|nome)`, "i");

const RULES: Array<[RegExp, string]> = [
  // Usuário e senha dentro de URL de conexão (postgresql://user:senha@host).
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[redigido]@"],
  // JWT.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, "[token]"],
  // Cabeçalho Authorization.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [token]"],
  // chave=valor e "chave":"valor" de campos sensíveis.
  [new RegExp(`\\b(${SENSITIVE_KEY_WORDS})(["']?\\s*[:=]\\s*["']?)([^\\s"',;&}\\]]+)`, "gi"), "$1$2[redigido]"],
  // Tokens com prefixo conhecido (Mercado Pago, GitHub, Stripe-like, AWS).
  [/\b(?:sk|pk|rk|ghp|gho|ghs|xox[abp]|APP_USR|TEST|AKIA|enc)[-_:][A-Za-z0-9_:+/=-]{12,}/g, "[token]"],
  // E-mail (inclui JID do WhatsApp, 5511...@s.whatsapp.net).
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  // CNPJ e CPF (formatados ou só dígitos).
  [/(?<!\d)\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?!\d)/g, "[documento]"],
  [/(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/g, "[documento]"],
  // Telefone: 10 a 13 dígitos com ou sem DDI, DDD e separadores. Número de linha/coluna de stack é curto e não casa.
  [/(?<![\dA-Za-z])(?:\+?\d{1,3}[\s.-]?)?\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}(?!\d)/g, "[telefone]"],
  // Sequências longas e misturadas (chave de API, hash de sessão) que sobraram.
  [/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g, "[token]"],
  // Pasta pessoal no caminho do arquivo (C:\Users\Fulano, /home/fulano).
  [/(?:[A-Za-z]:)?[\\/](?:Users|home)[\\/][^\\/\s:)]+/g, "[pasta]"],
];

/** Tira o byte nulo (o Postgres recusa em texto) e aplica todas as regras de redação. */
export function redactText(input: string): string {
  let out = input.replace(/\u0000/g, "");
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out;
}
