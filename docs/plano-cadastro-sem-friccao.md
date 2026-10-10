# Plano: cadastro sem fricção (2026-10-10)

Autora: Nova (arquitetura). Status: plano, nada implementado. Decisões do dono pendentes na seção 8.

## Ajustes de contrato (Vega)

Implementado em 2026-10-10 (F1a, F1c backend e F2). Onde isto diverge das seções 5.x, vale isto.

**`signUpAction`** (`src/modules/signup/actions.ts`)
- Saída: `Result<{ tenantSlug: string; sessionStarted: boolean; couponDropped: boolean }>` (tipo `SignUpActionData`).
- `phone` ausente vira `""` e o serviço devolve `INVALID_PHONE` (não `INVALID_PAYLOAD`). A regra é a do `normalizeBrPhoneStrict` (`src/core/contact/br-phone.ts`): tamanho, celular com 9, e **DDD tem que existir** (lista dos 67). A mensagem é "Informe o WhatsApp com DDD, por exemplo (84) 99999-8888.".
- `DISPOSABLE_EMAIL` vem do serviço (lista em `src/core/signup/disposable-email.ts`), não do zod.
- Honeypot (`website` preenchido): resposta de sucesso falso `{ tenantSlug: <slug do nome>, sessionStarted: false, couponDropped: false }`, nada é criado, log `signup.honeypot`.
- `slug` do cliente é ignorado; `document`, `segment` e `billingCycle` continuam aceitos (legado). Documento preenchido e inválido continua `INVALID_DOCUMENT`; vazio ou só espaços vale como ausente.
- Colisão de endereço: até **3** tentativas com `pickAvailableSlug` novo (o plano dizia 1; cadastros simultâneos do mesmo nome podem escolher o mesmo sufixo). Esgotou: `SLUG_TAKEN` com mensagem genérica.
- Cupom que não vale (prévia) ou que esgota entre a prévia e a transação: a conta nasce sem cupom e `couponDropped = true`. Nunca `COUPON_*`.
- Sessão: aberta pelo provedor `verified-login`; falhou = `sessionStarted: false` (conta criada, a tela cai em "Confirme seu e-mail").
- Log `signup.rejected` com **só o código** (ou `INVALID_PAYLOAD` com os nomes dos campos).
- Sem documento: o MP não é chamado e o e-mail "Sua fatura chegou" **não** sai no dia 0; o evento `INVOICE_CREATED` do histórico leva `hasDocument: false`.

**`completeGoogleSignUpAction`**: saída `{ redirectTo: string; couponDropped: boolean }`. `phone` obrigatório (`INVALID_PHONE`), `document` opcional (legado). Cupom: cookie `innochat_signup_coupon` (lido e apagado no servidor); `couponCode` do cliente só vale se não houver cookie.

**`signInWithGoogleAction(formData?: FormData)`** (`src/app/(public)/google-actions.ts`): campo opcional `coupon`. Código com formato válido vira cookie (httpOnly, Lax, 30 min); sem cupom válido o cookie antigo é apagado.

**`saveDocumentAndGeneratePixAction(tenantSlug, { document })`** está em `@/modules/billing/actions`: `Result<{ invoiceId: string | null; pixCopyPaste: string | null }>`, só OWNER, 8 chamadas por 10 min por empresa, **sem** `assertTenantCanWrite` (conta suspensa precisa conseguir pagar). Documento já com Pix vigente na fatura aberta: devolve o mesmo Pix, não gera outro QR. Erros: `INVALID_DOCUMENT`, `RATE_LIMITED`, `NOT_FOUND` (sem e-mail de cobrança), `MERCADOPAGO_*` (o documento já ficou salvo).

**Reprecificação (F2)**: `changeBillingCycleAction` devolve também `trialInvoiceRepriced: boolean` (e `openInvoiceKeepsOldCycle` fica `false` quando a fatura do teste foi recriada); `applyMyCouponAction` devolve `CouponApplication` (= `CouponPreview` + `trialInvoiceRepriced`); `changePlanAction` devolve `trialInvoiceRepriced` junto de `appliedImmediately` (upgrade e downgrade agendado no teste também recriam a fatura). A nova fatura nasce com `periodStart` = instante da troca (a chave única `subscriptionId + periodStart` não deixa repetir o da anulada), `periodEnd` e `dueAt` iguais aos da antiga. `applyInvoicePayment` passou a travar a linha da assinatura antes da fatura (mesma ordem de troca de ciclo e cancelamento, evita deadlock), e pagamento que cai numa fatura anulada na corrida marca `paidWhileVoidAt`.

**Régua**: `DunningInput.hasDocument` (obrigatório). Fatura do teste só planeja `INVOICE_CREATED` com documento; o despachante não tenta regerar Pix sem documento e o texto de `TRIAL_T1`/`TRIAL_T0` manda informar o CPF ou CNPJ na tela Assinatura **só quando não há documento e também não há Pix vigente** (`DunningCopyData.needsDocument`).

**Faixa do painel**: `needsDocument` é calculado em `layout.tsx` por `shouldAskForDocument` (`src/core/billing/document-notice.ts`): OWNER, status efetivo `TRIALING`, nunca pagou, sem cancelamento agendado, sem documento válido e faltando entre 0 e 24 h para o fim do teste.

**Termos**: `TERMS_VERSION = "2026-10-10"` (D6: política de privacidade cita o telefone do responsável). Abas abertas com a versão velha recebem `TERMS_VERSION_OUTDATED`.

## 0. Contexto e hipóteses

- Campanha Meta: 52 cliques em `/cadastro`, 2 eventos `Lead`, 0 cadastros.
- **O `Lead` só conta quem aceitou o aviso de cookies** (`trackPixel` não faz nada sem consentimento,
  `src/components/public/meta-events.ts:101-133`). "2 começaram" é piso, não retrato. Mesmo assim, 0
  de 52 é sinal claro de abandono.
- Público vem do Instagram, ou seja, **navegador embutido do Instagram no celular**.
- Escala: dezenas/centenas de empresas. MVP em produção. Nada de serviço novo, fila ou captcha pago.
- Restrição do dono: menos fricção, cadastros válidos, nada quebrado (cobrança, Pix, faturas, cupons,
  termos/LGPD, Meta, onboarding, n8n, admin).

### Achado que provavelmente pesa mais que o tamanho do formulário

O Google **bloqueia OAuth dentro de navegadores embutidos** (WebView do Instagram/Facebook): a pessoa
toca em "Cadastrar com Google" e recebe a tela de erro `403 disallowed_useragent`. O botão hoje é o
primeiro elemento do formulário (`page.tsx`, prop `top`). Quem vem do anúncio tenta o caminho "rápido",
bate no erro e vai embora. **Íris precisa confirmar num celular real abrindo o link pelo Instagram.**
Recomendação: no navegador do Instagram/Facebook (UA com `Instagram`, `FBAN`, `FBAV`, `FB_IAB`), não
mostrar o botão do Google; mostrar o formulário curto direto, com uma linha discreta "Prefere entrar
com Google? Abra esta página no navegador" (sem botão que leva ao erro).

## 1. Mapa downstream de cada campo (o que cada um alimenta hoje)

| Campo | Onde é gravado | Quem lê depois | Pode sair do cadastro? |
|---|---|---|---|
| Nome da empresa | `Tenant.name` | painel, e-mails, descrição do Pix, CSV financeiro, payer.name no MP | **Fica** |
| Endereço (slug) | `Tenant.slug` (unique) | URL do painel `/[tenantSlug]`, nome da instância Evolution (`buildInstanceName`, `whatsapp/service.ts:143`) | **Sai**: gerar com `pickAvailableSlug` (já existe e já é usado no Google, `signup/service.ts:410`). Não existe tela para editar slug; não prometer "editável depois" (trocar slug quebraria URLs salvas e nomes de instância). A dica atual `innochat.app/SEU-ENDEREÇO` nem é o domínio real. |
| Segmento | `Tenant.segment` (nullable) | **ninguém lê** (só grava; política de privacidade cita) | **Sai**. Opcional depois no onboarding, se o dono quiser para marketing. |
| Seu nome | `User.name` | e-mails, saudação, painel | **Fica** |
| CPF/CNPJ | `Tenant.document` (nullable) | `resolvePayerForInvoice` (Pix MP), `tick.ts#regenerateExpiredPix`, `finance-csv.ts`, Assinatura (`hasDocument`), Configurações (`EmpresaDocumentForm` + `updateTenantDocumentAction`) | **Sai**. Todo o caminho "sem documento" já existe e é testado: fatura nasce OPEN sem Pix, `tryAttachPix` loga `info` e devolve `null`, e-mail de fatura tem versão sem Pix, régua manda pagar pelo painel, Assinatura mostra alerta com link. Coluna já é nullable (empresas antigas). |
| WhatsApp | `Tenant.billingWhatsappE164` (nullable) | régua de cobrança por WhatsApp, confirmação de posse (`billingWhatsappConfirmedAt`), CAPI (hash) | **Fica e vira obrigatório** (hoje é opcional). É o canal de cobrança e o melhor sinal de cadastro real. |
| E-mail | `User.email` (unique) | login, verificação, faturas, régua | **Fica** |
| Senha + confirmar | `User.passwordHash` | login | **Fica só a senha**, com mostrar/ocultar. `confirmPassword` nunca foi ao servidor, só existe no cliente. |
| Ciclo pós-teste | `Subscription.billingCycle` + `Invoice.cycle` da fatura do teste | `priceInvoice`, `applyInvoicePayment` (meses do período), régua | **Sai**. Sem valor, o servidor já usa `MONTHLY` (`createAccount`: `effectiveCycle(plan, input.billingCycle ?? "MONTHLY")`). Troca depois em Assinatura (`CicloCard`, `changeBillingCycleAction`). Ver risco R1. |
| Cupom | `Subscription.couponId`, `Invoice.couponCode/discountCents`, `CouponRedemption` | preço da fatura do teste e seguintes | **Sai do formulário**; entra por link `?cupom=` (não existe hoje, é trivial) e pela tela Assinatura (`applyMyCouponAction`, já existe). Ver risco R1. |
| Aceite de termos | `User.termsAcceptedAt`, `User.termsVersion` (servidor grava `TERMS_VERSION`, confere com `assertCurrentTermsVersion`) | prova do aceite | **Fica** como texto junto do botão (clickwrap) ou checkbox. Ver D2. |

### Cadastro com Google hoje

Não é "1 clique": depois do Google cai em `/cadastro/google` pedindo nome da empresa, CPF/CNPJ, WhatsApp,
ciclo, cupom e checkbox de termos (`google-signup-form.tsx`). Já pula: nome da pessoa, e-mail, senha,
slug (automático), segmento, verificação de e-mail (já nasce verificado) e já abre sessão sozinho.

### O que acontece hoje no fim do cadastro por senha

Tela "Confirme seu e-mail" + botão "Ir para o login". **A pessoa não entra no painel.** Só a conexão do
WhatsApp exige e-mail verificado (`requireVerifiedEmail`, `lib/auth/guards.ts:54`); o resto do painel
funciona sem. É mais um degrau desnecessário: dá para abrir a sessão na hora com o provedor
`verified-login` que já existe (prova assinada de 60 s, mesmo padrão do Google).

## 2. Cadastro mínimo proposto

**Formulário (senha):** Nome da empresa · Seu nome · WhatsApp · E-mail · Senha (com mostrar/ocultar) ·
linha de aceite · botão "Criar conta grátis". Sem seções numeradas (5 campos não precisam de agrupamento).

**Google:** fora do navegador embutido, botão no topo. Depois do Google: Nome da empresa · WhatsApp ·
linha de aceite · botão. São 2 campos, o mínimo possível sem inventar nome de empresa.

**Depois do cadastro:** sessão aberta, `trackPixel("CompleteRegistration")`, redireciona para
`/pos-login` (que leva ao onboarding). O e-mail de verificação continua saindo; o painel já tem o aviso
de e-mail não verificado e o gate do WhatsApp continua.

### Onde CPF/CNPJ é coletado e o que bloquear

Regra: **a fatura nunca depende do documento; só o Pix depende.** Nada é bloqueado no teste.

1. **Tela Assinatura, cartão do Pix** (`assinatura-client.tsx`, ramo `!hasDocument`, linha ~306): hoje
   manda para Configurações. Passa a ter o campo CPF/CNPJ **ali mesmo** + botão "Gerar Pix". Salvar
   grava o documento e já gera o Pix da fatura aberta. É o momento natural: a pessoa quer pagar.
2. **Aviso no painel (só OWNER, só TRIALING sem documento, a partir de 24 h antes do fim do teste)**:
   faixa "Para pagar com Pix no fim do teste, informe o CPF ou CNPJ" com link para Assinatura.
   Antes disso, nada: não poluir o primeiro uso.
3. **Régua**: TRIAL_T1 e TRIAL_T0 já mandam pagar pelo painel quando não há Pix. Ajustar o texto para
   dizer "informe o CPF ou CNPJ na tela Assinatura para gerar o Pix" quando faltar documento.
4. **E-mail "Sua fatura chegou" do dia 0**: hoje sai no cadastro. Sem documento ele sairia sem Pix,
   dizendo "abra a tela de Assinatura para gerar o Pix" no primeiro minuto de um teste grátis. Proposta
   (D4): não enviar no cadastro quando não houver Pix; a etapa INVOICE_CREATED da fatura do teste só é
   planejada quando a empresa tem documento, então o e-mail sai com o Pix assim que o CPF/CNPJ entrar.
5. **Fim do teste sem documento**: comportamento atual, sem mudança. Fatura OPEN sem Pix, régua segue,
   suspensão pela regra existente. Nada quebra.
6. **Configurações** continua com `EmpresaDocumentForm` (correção posterior).

### Cupom por link

Não existe hoje. É trivial:
- `/cadastro?cupom=CODIGO`: `page.tsx` lê `searchParams.cupom` no servidor, valida com a mesma lógica de
  `previewSignupCouponAction` (sem rate limit de action, chamada direta ao serviço) e passa ao formulário
  `coupon: { code, summary } | null`. Cupom inválido: não mostra nada de erro, só não aplica.
- Formulário mostra um selo "Cupom CODIGO aplicado: <resumo>" e envia `couponCode`.
- Google: o botão manda o cupom para `signInWithGoogleAction`, que grava cookie httpOnly
  `innochat_signup_coupon` (30 min, SameSite=Lax); `completeGoogleSignUpAction` lê o cookie no servidor
  e apaga.
- Cupom que esgotar entre abrir a página e enviar **não pode derrubar o cadastro** (hoje derruba com
  COUPON_INVALID). No fluxo novo: conta criada sem cupom, resposta `couponDropped: true`, o painel avisa.
- Atenção: `MetaTracking stripQuery` limpa a query no cliente. A leitura do cupom tem que ser no
  servidor (`searchParams`), que já acontece antes.

## 3. Cadastros válidos sem passo extra

**Já existe:** rate limit por IP (5/h cadastro senha, 5/h Google por IP e por `sub`), em memória;
verificação de e-mail (gate do WhatsApp); unicidade de e-mail; validação BR de telefone
(`normalizeBrPhoneToE164`: tamanho, DDD sem zero, celular com 9); confirmação de posse do WhatsApp de
cobrança pela régua; aceite versionado. **Não existe:** captcha, honeypot, bloqueio de e-mail
descartável, lista de DDD válidos.

**Recomendo (todos invisíveis para quem é real):**
1. WhatsApp obrigatório + **lista dos 67 DDDs válidos** em `core/contact/br-phone.ts` (função pura).
2. **Honeypot**: campo `website` fora da tela (`tabIndex=-1`, `autoComplete="off"`, `aria-hidden`).
   Preenchido: servidor responde sucesso falso sem criar nada e loga `signup.honeypot`.
3. **E-mail descartável**: lista estática curta (mailinator, yopmail, guerrillamail, 10minutemail,
   temp-mail, tempmail, sharklasers, trashmail, dispostable, getnada, maildrop, mohmal, etc.) em
   `core/signup/disposable-email.ts`. Erro `DISPOSABLE_EMAIL`. Sem consulta DNS/MX (latência e falso
   negativo).
4. **Sugestão de erro de digitação no e-mail** (só cliente, não bloqueia): `gmial.com`, `gmail.con`,
   `hotmial.com`, `outlok.com` etc. → "Você quis dizer ...@gmail.com?" com um toque para corrigir.
5. Log agregado `signup.rejected` com o código do erro (sem dado pessoal), para saber onde as pessoas
   travam na próxima campanha.
6. **Não** adicionar: captcha, SMS/OTP, verificação de e-mail antes de entrar, tempo mínimo de
   preenchimento (gerenciador de senha preenche rápido e daria falso positivo).

## 4. A página `/cadastro` no celular

Hoje, de cima para baixo (390 px): banner do mascote `h-[7.5rem]` + padding; linha "Já tem conta?
Entrar"; título "Crie sua conta em 2 minutos" + subtítulo; botão Google + divisor "ou"; seção 1 com 3
campos; seção 2 com 4; seção 3 com 2; seção 4 com cartões de ciclo e cupom (`SignupBillingSection`);
checkbox; botão. O botão "Criar conta" fica a várias telas de distância.

Proposta:
- `AuthShell` ganha `compactMobileBrand`: no celular, troca o banner por um wordmark pequeno
  (balão + "InnoChat", ~32 px) na mesma linha do "Já tem conta? Entrar". Desktop sem mudança.
- Título curto: "Crie sua conta grátis". Subtítulo: "3 dias de teste. Sem cartão."
- Google só fora do navegador embutido (seção 0).
- Tirar `SignupBillingSection` e a prop `pricing` (e a consulta `getDefaultSignupPlan` da página: uma ida
  ao banco a menos no carregamento).
- Tirar `FormSection` numeradas.
- Inputs com `autoComplete` certo (`organization`, `name`, `tel`, `email`, `new-password`),
  `inputMode="tel"` e `enterKeyHint="next"`; fonte >= 16 px nos inputs (iOS dá zoom abaixo disso,
  medir).
- Meta de layout (Lyra mede, não deduz): em 390x844, título + primeiro campo visíveis sem rolar, e o
  botão "Criar conta" alcançável com no máximo uma rolagem. Conferir também se o aviso de cookies cobre
  o formulário no celular.

## 5. Contratos

### 5.1 `signUpAction` (Vega) — `src/modules/signup/actions.ts`

Entrada (zod):
```
{
  companyName: string 2..120            // obrigatório
  name: userNameSchema                  // alias legado ownerName continua aceito
  email: string email <=255             // obrigatório
  password: string 8..200               // obrigatório
  phone: string <=30                    // OBRIGATÓRIO agora; inválido = INVALID_PHONE
  termsVersion: string                  // continua conferido com assertCurrentTermsVersion
  acceptedTerms: true                   // continua; no clickwrap o cliente manda true ao tocar no botão
  couponCode?: string <=40              // vindo do link
  metaEventId?: string <=64
  website?: string <=200                // honeypot; preenchido = sucesso falso
  // LEGADO (aba antiga em cache): aceitos e opcionais
  slug?: string                         // IGNORADO: slug sempre automático
  segment?: string <=80                 // se vier, grava
  document?: string                     // se vier não vazio, valida (INVALID_DOCUMENT) e grava
  billingCycle?: BillingCycle           // se vier, respeita (INVALID_CYCLE como hoje)
}
```
Saída: `Result<{ tenantSlug: string; sessionStarted: boolean; couponDropped: boolean }>`.

Erros para a tela: `EMAIL_TAKEN`, `INVALID_PHONE`, `DISPOSABLE_EMAIL`, `TERMS_VERSION_OUTDATED`,
`RATE_LIMITED`, `INVALID_PAYLOAD` (o que `runAction` já devolve para erro de zod; a mensagem é técnica, a tela mostra uma genérica), `INVALID_DOCUMENT` e
`INVALID_CYCLE` só no legado. `SLUG_TAKEN`/`INVALID_SLUG` deixam de chegar à tela (só em caso extremo
de 50 colisões, mensagem genérica). `COUPON_INVALID` deixa de derrubar o cadastro (vira `couponDropped`).

Comportamento:
- `SignUpInput.document` vira `string | null | undefined`; `CreateAccountInput.documentDigits` vira
  `string | null`. Sem documento: **não chamar `tryAttachPix`** no cadastro (evita log e chamada inútil).
- Slug: `pickAvailableSlug(companyName)` nos dois cadastros. Corrida (SLUG_TAKEN dentro da transação):
  repetir uma vez com novo `pickAvailableSlug`.
- Cupom: checar com `previewCoupon` ANTES da transação; inválido = segue sem cupom (`couponDropped`).
  Se ainda assim falhar dentro da transação (corrida), refazer `createAccount` uma vez sem cupom.
- Sessão: depois de criar, `signIn("verified-login", { proof: signGoogleToken("login-verified",
  { userId }, 60_000), redirect: false })` (import dinâmico de `@/lib/auth`, como no Google). Falhou:
  `sessionStarted: false` e a conta continua criada.
- CAPI `trackCompleteRegistration`: sem mudança.

### 5.2 `completeGoogleSignUpAction` (Vega)

Entrada: `{ token, tenantName, phone (OBRIGATÓRIO), acceptTerms: true, metaEventId?, legado opcional:
document?, billingCycle?, couponCode?, planCode? }`. Cupom vem do cookie `innochat_signup_coupon`
(servidor), não do cliente; `couponCode` do cliente só como legado. Saída sem mudança
(`{ redirectTo }`), mais `couponDropped`.

### 5.3 `signInWithGoogleAction` (Vega)

Aceita `FormData` opcional com `coupon`; se vier, grava o cookie do cupom (httpOnly, Secure, Lax,
30 min) antes do `signIn("google")`.

### 5.4 Documento na hora de pagar (Vega)

`saveDocumentAndGeneratePixAction(tenantSlug, { document }): Result<{ invoiceId: string | null;
pixCopyPaste: string | null }>` — OWNER, rate limit por tenant. Faz `updateTenantDocument` + auditoria
(mesma de `updateTenantDocumentAction`) e, se houver fatura OPEN sem Pix vigente, chama
`regeneratePixForInvoice`. Erros: `INVALID_DOCUMENT`, `MERCADOPAGO_*` (documento fica salvo mesmo se o MP
falhar; a tela mostra "documento salvo, tente gerar o Pix de novo").

### 5.5 Ajustes de cobrança (Vega)

- `tick.ts#regenerateExpiredPix`: pular faturas de empresa sem documento válido (hoje tenta toda rodada
  e loga `warn` em cada uma; com cadastro sem CPF isso vira ruído constante).
- Régua: planejador (`core/billing/dunning.ts`) recebe `hasDocument`; INVOICE_CREATED da fatura do teste
  só com documento (D4). Cópia de TRIAL_T1/T0 ganha a frase do documento quando faltar.
- Snapshot do layout do tenant: expor `needsDocument` (OWNER + TRIALING + sem documento + faltam
  <= 24 h) para a faixa do painel.

### 5.6 Fase 2 (Vega): fatura do teste acompanha ciclo e cupom escolhidos no teste

Hoje `changeBillingCycle` e `applyCouponToSubscription` valem "a partir da próxima fatura"; a fatura do
teste já existe desde o cadastro, então quem escolher anual ou aplicar cupom durante o teste paga a
primeira fatura mensal e cheia. Com o ciclo e o cupom saindo do cadastro, isso passa a ser o caminho
normal. Proposta: `repriceTrialInvoice(tenantId)` chamada por essas duas actions (e, opcional, pelo
upgrade de plano no teste, que tem a mesma lacuna) quando `status = TRIALING`, `firstPaidAt = null` e a
fatura `isTrialConversion` está OPEN:
- **Anular e recriar**, não editar no lugar: `voidOpenInvoices` + `cancelPixPayments` na fatura velha,
  nova fatura `isTrialConversion: true` com o preço atual, mesmo `dueAt`. Motivo: se o Pix velho for pago
  numa corrida, `applyInvoicePayment` de fatura VOID só marca `paidWhileVoidAt` (o admin decide); editar
  no lugar faria um Pix mensal baixar uma fatura anual e dar 12 meses pelo preço de 1.
- Cupom: devolver o ciclo gasto na fatura anulada (`couponCyclesRemaining + 1` quando não for nulo) e
  gastar de novo na nova (`consumeCouponCycleInTx`), apontando o resgate para a fatura nova.
- Régua: a nova fatura não reenvia "Sua fatura chegou" por troca de ciclo (gravar o aviso como já
  tratado) para não virar spam a cada clique.
- Sem migration.

### 5.7 Tela (Lyra)

- `cadastro-form.tsx`: 5 campos + linha de aceite (ou checkbox, D2) + honeypot + selo do cupom; remove
  slug, segmento, documento, confirmar senha, `SignupBillingSection`, `FormSection`. Senha com botão
  mostrar/ocultar (`aria-pressed`, rótulo "Mostrar senha"). Sugestão de e-mail digitado errado.
  Sucesso com `sessionStarted`: `trackPixel("CompleteRegistration", id)` e
  `window.location.assign("/pos-login")`; sem sessão: tela atual "Confirme seu e-mail".
  `couponDropped`: nada no cadastro; o painel mostra.
- Mensagens de erro novas: `DISPOSABLE_EMAIL` ("Use um e-mail que você acessa sempre: é por ele que
  chegam os avisos da conta."), `INVALID_PHONE` (texto atual), `EMAIL_TAKEN` com links "Entrar" e
  "Esqueci a senha".
- `page.tsx`: lê `cupom` e UA (`headers()`), decide Google sim/não, sem `pricing`.
- `AuthShell`: `compactMobileBrand`.
- `google-signup-form.tsx`: Nome da empresa + WhatsApp + aceite.
- Assinatura: campo CPF/CNPJ inline no cartão do Pix (com ícone de ajuda ⓘ e exemplo, regra do dono).
- Faixa `needsDocument` no painel.
- Textos pelo `docs/guia-de-voz.md`, sem travessão.

## 6. Fases e dependências

| Fase | Quem | Depende de | Entrega |
|---|---|---|---|
| F0 | Íris | nada | Confirmar no celular real (link aberto pelo Instagram) o erro do Google; medir a página atual em 390x844. Pode rodar já. |
| F1a | Vega | D1, D3 | 5.1, 5.2, 5.3, honeypot, descartáveis, DDDs, slug automático, sessão na hora. Sem migration. |
| F1b | Lyra | contrato 5.1-5.3 (este doc) | 5.7 cadastro, Google, `AuthShell`, página. Em paralelo com F1a. |
| F1c | Vega + Lyra | F1a | 5.4 e 5.5 (documento na hora de pagar, faixa, régua, tick). |
| F1d | Íris → Órion | F1a-c | Testes (seção 7) e revisão (rota pública, honeypot, cookie do cupom, sessão automática). |
| F1e | Alexandria | F1d | `docs/contratos.md` "Cadastro público" (substitui a seção de 2026-09-29), comentários do schema de `Tenant.document`, manual do cliente. Se D6, política de privacidade + `TERMS_VERSION`. |
| F2 | Vega → Íris | F1 publicada | 5.6 reprecificação da fatura do teste. Pode publicar depois; até lá a tela de Assinatura já avisa que a fatura aberta mantém o ciclo antigo (`openInvoiceKeepsOldCycle`). |

F1 pode ir ao ar sem F2: nada quebra, só a primeira fatura de quem trocar o ciclo no teste sai mensal.

## 7. Riscos e testes

### Riscos

- **R1** Ciclo/cupom fora do cadastro: primeira fatura sai mensal e sem desconto se a escolha for feita
  no teste, até a F2. Cupom por link cobre campanhas.
- **R2** Mais contas sem documento: Pix só nasce quando o CPF/CNPJ entrar. Mitigação: campo na hora de
  pagar, faixa nas últimas 24 h, régua com o texto certo. Pode subir a inadimplência do primeiro mês:
  medir.
- **R3** Sessão aberta antes de verificar o e-mail: já era possível fazer login sem verificar; o gate
  do WhatsApp continua. Órion confere que a prova não vaza ao cliente.
- **R4** Aba antiga em cache durante o deploy: manda `slug`, `document`, `billingCycle` e talvez sem
  `phone`. Os três primeiros são aceitos; sem `phone` vira erro de validação. Janela pequena, aceito.
- **R5** Rate limit em memória zera no deploy e 4G com NAT compartilha IP. Volume atual não justifica
  mudar.
- **R6** Esconder Google por UA: lista de UAs de navegador embutido muda. Errar para o lado de mostrar
  o formulário (que sempre funciona).
- **R7** Política de privacidade não cita o telefone do responsável no item "Cadastro". Mudar o texto
  pede nova `TERMS_VERSION` (D6).
- **R8** `fbclid` é removido da URL antes do Pixel ler (`stripQuery`); isso pode impedir o cookie
  `_fbc` e piorar a atribuição. Fora deste escopo, vale uma missão separada.

### Testes que a Íris deve rodar/atualizar

Existentes que tocam o cadastro:
- `tests/e2e/cadastro.spec.ts` — `fillValidForm` preenche slug, CPF e confirmar senha: **reescrever**.
  Casos de slug reservado/duplicado viram "nome repetido gera `-2`". Caso de CPF some do cadastro e vai
  para Assinatura. Novo: entra direto no painel depois do cadastro.
- `tests/e2e/google-cadastro-cookie.spec.ts`.
- `tests/integration/billing-signup.integration.test.ts` — o primeiro caso exige documento: manter com
  documento (legado) e **somar** "sem documento: fatura OPEN sem Pix, sem chamada ao MP, sem e-mail de
  fatura no dia 0".
- `tests/integration/google-auth.integration.test.ts` (`completeGoogleSignUp`, slug único, documento
  inválido no legado).
- `tests/integration/billing-dunning-signup-contact.integration.test.ts` (telefone agora obrigatório:
  o caso "sem telefone grava null" muda para erro).
- `tests/integration/billing-annual-coupons.integration.test.ts` (cupom e ciclos; base da F2).
- Unitários: `src/lib/legal.test.ts`, `src/modules/google-auth/signup-cookie.test.ts`,
  `src/components/public/meta-events.test.ts`, `src/lib/email/__tests__/templates.test.ts`,
  testes da régua em `src/core/billing` (planejador com `hasDocument`), `src/modules/tenant/actions.test.ts`.

Novos:
- Unit: DDD válido/inválido; e-mail descartável; sugestão de domínio; `pickAvailableSlug` com nomes
  curtos/reservados/acentuados.
- Integração: honeypot não cria nada e responde sucesso; cupom do link esgotado não derruba o cadastro;
  `saveDocumentAndGeneratePixAction` (OWNER sim, STAFF não, MP fora do ar mantém documento);
  tick não tenta Pix de empresa sem documento; régua não planeja INVOICE_CREATED do teste sem documento
  e planeja quando o documento entra.
- E2E 390x844: medir primeiro campo e botão (skill `medir-antes-de-afirmar`); UA do Instagram esconde o
  Google; `?cupom=` mostra o selo e o desconto aparece na fatura do teste; evento `CompleteRegistration`
  dispara antes de sair da página (com consentimento).
- F2: trocar para anual no teste anula e recria a fatura, cancela o Pix velho, cupom não perde ciclo;
  Pix velho pago depois marca `paidWhileVoidAt` e não dá 12 meses.
- Regressão geral: `npm run build` limpo, suite de cobrança inteira (tick, régua, Pix, cupons).

## 8. Decisões do dono

- **D1** Reverter a decisão de 2026-09-29 (CPF/CNPJ obrigatório no cadastro) e pedir o documento só na
  hora de pagar. Recomendo sim.
- **D2** Aceite: texto junto ao botão ("Ao criar a conta, você concorda com os Termos de uso e a
  Política de privacidade", com links) ou manter o checkbox. O servidor grava o mesmo aceite versionado
  nos dois casos, e os Termos já dizem que "o aceite é registrado no cadastro, com a versão e a data".
  Recomendo o texto, mas é escolha jurídica: confirme com quem cuida disso.
- **D3** WhatsApp obrigatório (hoje opcional). Recomendo sim.
- **D4** Não mandar "Sua fatura chegou" no dia 0 sem Pix; mandar quando o documento entrar. Recomendo sim.
- **D5** Fazer a F2 logo depois da F1, ou aceitar que a primeira fatura de quem troca o ciclo no teste
  saia mensal. Recomendo F2 em seguida. Também: campo "Tenho um cupom" no cadastro ou só link +
  Assinatura (recomendo só link + Assinatura).
- **D6** Incluir "telefone (WhatsApp) do responsável" na política de privacidade e subir `TERMS_VERSION`
  junto. Recomendo sim, no mesmo deploy.
- **D7** Segmento: perguntar depois no onboarding (opcional) ou abandonar o campo. Sem urgência.
