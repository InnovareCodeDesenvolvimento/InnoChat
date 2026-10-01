/**
 * Mensagens em pt-BR para o `?error=` que o Auth.js devolve à tela de login/cadastro depois de
 * uma volta do Google que não deu certo. Códigos desconhecidos caem no genérico.
 */
export type AuthErrorMessage = { title: string; description: string };

const MESSAGES: Record<string, AuthErrorMessage> = {
  AccessDenied: {
    title: "Não foi possível entrar com essa conta",
    description:
      "O e-mail da conta Google precisa estar verificado, e contas de administrador da plataforma entram só com e-mail e senha. Use outra conta ou entre com e-mail e senha.",
  },
  OAuthAccountNotLinked: {
    title: "Esse e-mail já tem cadastro",
    description:
      "Já existe uma conta com o e-mail dessa conta Google, mas ela não está ligada ao Google. Entre com e-mail e senha.",
  },
};

const GENERIC: AuthErrorMessage = {
  title: "Não foi possível entrar com o Google",
  description: "O login com o Google não foi concluído. Tente de novo em instantes ou entre com e-mail e senha.",
};

export function authErrorMessage(code: string | undefined): AuthErrorMessage | null {
  if (!code) return null;
  return MESSAGES[code] ?? GENERIC;
}
