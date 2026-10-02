# Revisão de segurança: Onda 1 de melhorias (f71a775..8c379a9)

Revisor: Órion (somente leitura). Data: 2026-10-02. Escopo: monitor de erros, 2FA, backup, Pixel/CAPI, plano anual e cupons, e varredura transversal de SQL cru.

**Veredito: BLOQUEIA a publicação** até corrigir A-1 e A-2 (as duas correções são pequenas). Nenhum achado CRÍTICO. Se o Atlas preferir publicar já, A-1 só se materializa com o Pixel ligado no Admin (padrão: desligado), mas A-2 já vale no primeiro deploy.

Contagem: CRÍTICO 0, ALTO 2, MÉDIO 7, BAIXO 9.

## O que NÃO foi provado
- Nada foi executado contra Postgres com fuso diferente de UTC; a seção 6 é leitura de código.
- Nenhuma chamada HTTP real nas rotas; o raciocínio sobre /api/auth/callback/* é por leitura de `src/lib/auth.ts` e `src/modules/two-factor/login.ts`.
- `npm audit` rodou (rede disponível); o resultado é do momento da execução.

---

## ALTO

### A-1. Token do cadastro com Google vai na URL e o Pixel manda a URL inteira à Meta
- Onde: `src/app/(public)/cadastro/google/page.tsx:39` monta `<MetaTracking />` numa página cuja URL é `/cadastro/google?t=<token>`. O token (`src/modules/google-auth/tokens.ts`, purpose `google-signup`) é só assinado, NÃO cifrado: carrega e-mail, nome e `sub` do Google em base64url.
- Cenário: visitante aceita o banner, o `fbevents.js` dispara `PageView` com `document.location` completo. A Meta recebe e-mail, nome e id Google da pessoa, em claro, na URL. O consentimento era para medir anúncio, não para isto. O token vale 15 min e a tela ainda exige o cookie de hash (S1), então não é tomada de conta, mas é vazamento de dado pessoal a terceiro (LGPD).
- Correção: tirar `MetaTracking` desta página, ou só carregar o Pixel depois de o token sair da URL (`history.replaceState` para `/cadastro/google` e guardar o token em memória/cookie httpOnly). Para o `CompleteRegistration` do navegador, disparar na própria `/cadastro` não é possível neste fluxo; o evento do servidor (CAPI) já cobre. Conferir também que nenhuma outra página com `MetaTracking` leva dado pessoal em query string (`/cadastro?error=` e `?cupom=` hoje não levam PII, mas o cupom vai à Meta).

### A-2. 2FA obrigatória só no layout: Server Actions do admin (e do usuário com `twoFactorRequired`) funcionam sem 2FA
- Onde: `src/lib/auth/guards.ts:32` (`requirePlatformAdmin` só confere `isPlatformAdmin`); gate apenas em `src/app/(platform)/admin/layout.tsx` e `src/app/(app)/[tenantSlug]/layout.tsx`.
- Resposta ao ponto aceito pelo Atlas: não concordo. O layout é só interface; Server Actions são endpoints POST, e os ids das actions estão no bundle público. Todo admin existente hoje está sem 2FA no momento do deploy. Quem tiver a senha de um admin (a ameaça que a 2FA existe para barrar) entra, e antes de o dono ativar a 2FA pode: trocar o destino do backup para um S3 dele ou conectar o Drive dele (o dump inteiro, com dado de clientes finais, sai do servidor no próximo ciclo; o e-mail de aviso do OAuth avisa, mas depois), trocar credenciais de Mercado Pago/SMTP, resetar a 2FA de outros admins, ou simplesmente ativar a própria 2FA e trancar o dono para fora. O mesmo vale para o login com Google (M-1).
- Correção: `requirePlatformAdmin` deve recusar (FORBIDDEN com código próprio) quando `totpEnabledAt` é nulo. As actions de 2FA usam `requireSessionUser`, então a ativação continua possível. Para `twoFactorRequired` de donos, aplicar o mesmo em `requireTenantMember` (ou num guard comum) quando o usuário exige e não ativou.

---

## MÉDIO

### M-1. Login com Google ignora a 2FA
- Onde: `src/lib/auth.ts:185-213` (callback `signIn` devolve `true` para conta existente) e `src/modules/google-auth/signin.ts` (vínculo por e-mail verificado).
- Cenário: conta com 2FA ligada, inclusive admin, entra só com o Google. Quem controla a conta Google tem o 2º fator do Google, mas o produto promete "obrigatória no admin". Decisão do dono: aceitar (Google como 2º fator) ou exigir TOTP também aqui. Se aceitar, documentar e não chamar de "obrigatória" na tela.
- Correção sugerida: no `jwt`/`signIn` do Google, se `totpEnabledAt` ou obrigatória, devolver para uma tela de desafio (reaproveitar `signGoogleToken("two-factor-challenge")`).

### M-2. /api/client-errors: crescimento sem teto, disputa com erros reais e texto do atacante no e-mail do admin
- Onde: `src/app/api/client-errors/route.ts:37` (corpo lido inteiro antes do rate limit; sem `Content-Length` o teto de 16 KB só é conferido depois de bufferizar), `src/modules/error-monitor/client-report.ts`, `src/modules/error-monitor/capture.ts:19` e `src/modules/error-monitor/service.ts:158`.
- Cenário 1: 20 relatos/min por IP com mensagens distintas criam grupos novos; a retenção de 30 dias apaga só `ErrorEvent`, nunca `ErrorGroup`. Com poucos IPs a tabela cresce sem fim e a tela Admin > Erros enche de lixo.
- Cenário 2: o teto de 120 gravações/min é compartilhado entre navegador e servidor. Um atacante gastando 120/min com relatos falsos faz o `captureRequestError` real cair em THROTTLED/BUSY (o erro de produção some).
- Cenário 3: `message`, `type` e `route` do atacante vão ao e-mail de alerta (HTML escapado, mas URLs em texto viram link no cliente de e-mail): vetor de phishing contra o admin vindo do remetente oficial.
- Correção: orçamentos separados para origem CLIENT e SERVER; teto de grupos CLIENT por dia; apagar grupos sem ocorrência há N dias; ler o corpo com limite (stream com contador) ou rejeitar sem `Content-Length`; no e-mail, não incluir texto de origem CLIENT (só contagem e link para o painel).

### M-3. Pixel/CAPI: retenção e retirada de consentimento, e consentimento afirmado pelo cliente
- Onde: `src/modules/meta/tracking.ts:72` e `:131` (`ProviderEvent` provider `meta-signup` e `meta-capi`, sem apagar nunca; só `billing-email` e `error-alert` têm limpeza); `src/modules/signup/actions.ts` (`metaEventId` vindo do cliente decide "houve aceite").
- Problemas: (a) IP, user agent, `_fbp` e `_fbc` ficam guardados para sempre; (b) quem revoga o consentimento depois ("Preferências de cookies") continua tendo o Purchase enviado semanas depois com e-mail e telefone em hash; (c) o aceite é só a presença de um id de 8-64 caracteres: um script ou um cliente com bug dispara envio à Meta sem banner. Para o produto o risco é de conformidade, não de invasão.
- Correção: expirar o payload do aceite (por exemplo apagar após o Purchase ou 60 dias) e guardar só o necessário; registrar a data/versão do texto do aceite; tratar a retirada (marcar a empresa como "sem rastreio" quando o dono revoga, ao menos pelo Minha conta); documentar na política de privacidade o envio de e-mail/telefone com hash.

### M-4. Enumeração de cupons e rate limit em memória
- Onde: `src/modules/billing/coupons.ts:54-85` e `src/modules/billing/coupon-actions.ts:54` (`previewSignupCouponAction`, 20 por 10 min por IP, `checkRateLimit` em memória).
- Cenário: "inexistente" e "desativado" respondem igual (bom), mas cupom que existe e está vencido, esgotado, de outro plano ou de outro ciclo responde com mensagem própria: confirma que o código existe. Quem chuta nomes comuns (BEMVINDO10, BLACKFRIDAY) descobre os que valem. O limite é por IP, reinicia a cada deploy e, sem cabeçalho de proxy, `clientIp()` cai em "unknown" (um balde só: vira negação de serviço do preview).
- Correção: na rota pública, devolver a mesma mensagem genérica para todo motivo de recusa; guardar o motivo detalhado só no painel da empresa autenticada (`previewMyCouponAction`); limite global do preview além do por IP; aleatoriedade nos códigos que valem muito (já há `maxRedemptions`, bom).

### M-5. Dependências com advisory
- `npm audit --omit=dev` (2026-10-02): 7 achados (6 altos, 1 crítico). Next 16.3.4 (RCE em `next/og` ImageResponse, GHSA-vcvr-r3jv-pc5j): o projeto não usa `next/og` (grep vazio), então sem exposição hoje; atualizar para 16.3.8+ mesmo assim. nodemailer: validação de domínio de destinatário e DoS no parser (GHSA-cc9r-2j5m-2m83, GHSA-wmmp-3585-3rmp); os destinatários são e-mails da plataforma/donos, risco baixo, mas atualizar. Não é da Onda 1 (a única dependência nova é `@aws-sdk/client-s3`, sem advisory no audit).

### M-6. S3: endpoint configurável aceita qualquer esquema e devolve o erro
- Onde: `src/modules/backup/actions.ts:39` (`z.string().url(...)` aceita `http://`, `file:` etc., apesar da mensagem dizer https) e `src/modules/backup/service.ts` (`s3Client`, `s3Failure` devolve até 300 caracteres da mensagem).
- Cenário: admin (ou quem tenha sessão de admin, ver A-2) aponta o endpoint para `http://169.254.169.254` ou serviço interno e lê a resposta pelo erro do "Testar conexão". Também permite mandar o dump por HTTP puro.
- Correção: exigir `https:`, recusar IP privado/loopback/link-local e nomes internos; não ecoar `message` cru do SDK.

### M-7. Dump sai do servidor sem cifra própria
- Onde: `src/modules/backup/service.ts` (`pg_dump` -Fc e envio direto).
- O dump traz hash de senha, e-mails, telefones, conversas e dados de clientes finais das empresas (inclusive de saúde/estética, e possivelmente de menores). Quem tiver acesso de leitura ao bucket ou ao Drive lê tudo. Os segredos `*Enc` do banco vão cifrados com chave do `AUTH_SECRET` (que não está no dump; ponto positivo).
- Correção: cifrar o arquivo antes do upload (chave pública `age`/GPG guardada fora do servidor) ou exigir SSE-KMS/bucket privado com política de acesso mínimo e documentar no runbook; no Drive, a pasta é criada pelo app com `drive.file` (bom).

---

## BAIXO

- B-1. `scripts/restore-db.sh:73,85`: a URL de destino com senha vai em argumento (`--dbname="$DESTINO"`, `psql "$DESTINO"`), visível em `ps`; o eco só mascara o formato `://user:senha@`. Usar `PGPASSWORD`/`PGSERVICEFILE` e `--dbname` sem senha.
- B-2. Dump temporário em `os.tmpdir()` com permissão padrão do processo (`service.ts`, `runBackup`). Criar o diretório/arquivo com modo 0600.
- B-3. `errorDetail` do backup (stderr do pg_dump) é gravado e enviado por e-mail; `scrub` só remove a senha da `DATABASE_URL`, não host nem usuário. Baixo risco; filtrar host/usuário também.
- B-4. 2FA: ativar não incrementa `sessionVersion` (sessões antigas, possivelmente roubadas, continuam valendo); não há e-mail de aviso ao ligar/desligar a 2FA, usar código de recuperação ou reset pelo admin. `src/modules/two-factor/service.ts`.
- B-5. `beginTwoFactorSetupAction` não exige senha: quem tem uma sessão roubada pode ligar a 2FA dele e trancar o dono (o admin reseta, mas é aborrecimento). Exigir a senha atual (ou reautenticação recente) para iniciar.
- B-6. CSP: `https://connect.facebook.net` entrou em `script-src` do site todo (`next.config.ts`), inclusive painel e admin, onde o Pixel nunca roda, e `'unsafe-inline'` segue. Escopar por rota (headers só para as páginas públicas de venda) se possível.
- B-7. Estado dos desafios de 2FA, limites por usuário/IP e fila do monitor ficam em memória: zeram a cada deploy e não valem com 2 instâncias (`src/modules/two-factor/login.ts`, `src/lib/rate-limit.ts`). Aceitável com 1 processo, já documentado nos comentários; registrar como premissa no runbook. O anti-replay do TOTP e o código de recuperação são atômicos no banco (bom).
- B-8. Conta de serviço do Drive usa escopo `drive` completo (`src/modules/backup/drive.ts:22`); `drive.file` basta para criar/listar/apagar o que o app criou. Com pasta compartilhada pelo dono, `drive.file` pode não enxergar a pasta; testar antes de trocar.
- B-9. `previewMyCouponAction`/`applyMyCouponAction` compartilham o limite com a troca de ciclo por empresa (`coupon-my`/`billing-cycle`); ok, só observar que 10 por 10 min em memória reinicia no deploy.

---

## Pontos avaliados e considerados corretos (Onda 1)

Monitor de erros:
- Redação (`src/core/error-monitor/redact.ts`) cobre URL com credencial, JWT, Bearer, chave=valor sensível, tokens com prefixo, e-mail, CPF/CNPJ, telefone, sequências longas e pasta pessoal; contexto descarta chaves sensíveis (inclui `message`, `name`, `body`). Rota recebe só `pathname`, sem query. `tenantId` nunca vem do corpo; `userId` só da sessão.
- Origin: ausente passa (curl), presente precisa ser o host; com limites por IP e global não é problema. Sem cookie de sessão atrelado, CSRF aqui não tem efeito.
- Reserva da janela de alerta via `ProviderEvent` (`alert.ts:75`): `createMany` com `skipDuplicates` sobre o único `(provider, providerEventId)` é atômico entre processos; linhas apagadas após 2 dias. Concordo com o desenho. Efeito conhecido: a janela é gasta mesmo quando o envio falha (documentado).
- `instrumentation.ts`: `register` e `onRequestError` com guarda de runtime, nada lança, o sink do logger recebe campos já redigidos.

2FA:
- Provedor `credentials` recusa conta com 2FA (`rejectIfTwoFactorEnabled`) depois de validar a senha; `/api/auth/callback/credentials` não abre sessão para ela. `verified-login` só aceita a prova assinada (chave derivada por purpose, 60 s, relê `totpEnabledAt`); `two-factor` só aceita desafio assinado (5 min, preso à `sessionVersion`), com 5 erros por desafio, 10 por usuário/15 min e 30 por IP/5 min, `inFlight` e consumo atômico no banco. As chaves por purpose impedem usar token de um provedor no outro. Não encontrei bypass pelo caminho de senha. O único desvio é o Google (M-1).
- Segredo TOTP cifrado em repouso (AES-GCM), QR e segredo só voltam na resposta da action autenticada do próprio usuário; códigos de recuperação com ~50 bits e HMAC no banco; nenhum segredo em log.

Backup:
- Segredos cifrados e mascarados (`configForPanel` lista explícita), OAuth com `state` assinado de 10 min, nonce de uso único no banco, sessão do admin igual ao `adminId` do state, `isPlatformAdmin` relido, motivos como códigos curtos, e-mail de aviso ao conectar/desconectar. `pg_dump` via `spawn` sem shell, senha por `PGPASSWORD`. Rota `/api/internal/v1/backup/tick` usa `timingSafeEqual` sobre hash do segredo.

Pixel/CAPI:
- ID do Pixel validado só dígitos antes de ir ao HTML; script só carrega após "Aceitar"; token da CAPI cifrado, vai no corpo (não na URL) e não entra em log; botão de teste limitado (10/min por admin) e exige código de teste.

Anual/cupons:
- O servidor recalcula tudo (`priceInvoice`, `effectiveCycle`); cliente só manda ciclo e código. Piso de R$ 1,00. `claimCouponRedemption` atômico, resgate único por empresa pela unique, `$transaction` em fatura + ciclo do cupom. Actions do Admin com `requirePlatformAdmin`, as da empresa com `requireTenantMember(slug, ["OWNER"])` e empresa resolvida pelo slug.

## 6. Varredura de `$queryRaw`/`$executeRaw` (projeto inteiro)

Hipótese da Vega: SQL cru com `Date` ligado a coluna `timestamp(3)` (sem fuso) grava/compara hora deslocada se a sessão do Postgres não está em UTC.

| Arquivo | Uso de data | Situação |
|---|---|---|
| `src/lib/db/coupon-redeem.ts` | `toISOString()` com `::timestamp` | Seguro: o sufixo `Z` é ignorado ao converter para `timestamp`, vale a hora UTC como dígitos |
| `src/lib/db/billing-notice-queries.ts` (3 consultas) | `toISOString()` com `::timestamp` | Seguro, mesmo motivo |
| `src/lib/db/error-queries.ts:42` | `${date}::timestamptz AT TIME ZONE 'UTC'` | Seguro desde que o parâmetro chegue como instante com fuso; nunca foi exercitado com sessão não UTC, ver recomendação |
| `src/lib/db/contact-queries.ts:64` | `c."botPausedUntil" > ${now}` (Date direto, coluna `timestamp(3)`, `schema.prisma:497`) | RISCO: filtro "bot pausado" desloca pelo fuso da sessão (leitura; só afeta a lista). Linhas 66 e 69-70 comparam com `a."startsAt"` (`timestamptz`), sem risco |
| `src/lib/db/advisory-lock.ts`, `src/app/api/health/route.ts`, `src/modules/backup/service.ts:363` | sem data | Sem risco |
| `scripts/bot-sim/*.mjs` | `*RawUnsafe` | Só desenvolvimento; `create-db.mjs` valida o nome por regex antes de interpolar |

Recomendações: (1) corrigir `contact-queries.ts:64` com `.toISOString()` + `::timestamp` (padrão da casa) ou trocar para `Prisma.sql` com a mesma conversão; (2) fixar a sessão em UTC na origem (parâmetro `options=-c timezone=UTC` na `DATABASE_URL`, ou `ALTER ROLE/DATABASE ... SET timezone='UTC'`), o que também protege `DEFAULT CURRENT_TIMESTAMP` de migrations e INSERT sem a coluna; (3) adicionar um teste de integração com `SET timezone='America/Sao_Paulo'` na sessão que grave e releia por `error-queries`, `coupon-redeem` e `billing-notice-queries`, pois a seção acima é só leitura de código.
