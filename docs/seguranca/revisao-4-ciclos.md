# Revisão de segurança: planos com 4 ciclos

Escopo: `git diff db7c4b2..HEAD` (596d750 schema, e230df0 código). Revisão só leitura, feita pelo Órion em 2026-10-03. Foco: dinheiro e abuso.

**Veredito: LIBERA.** Nenhum CRÍTICO. 2 IMPORTANTES (corrigir em breve, não bloqueiam) e 2 SUGESTÕES.

## CRÍTICO

Nenhum.

## IMPORTANTE

### I-1. Fim do período pago usa `setMonth` nativo, o resto do sistema usa `addMonths` (date-fns)
- Onde: `src/modules/billing/service.ts:493-494` (`applyInvoicePayment`). Compare com `tick.ts:336`, `cancellation.ts:355` e `core/billing/status.ts:150`, que usam `addMonths`.
- Problema: `Date#setMonth` estoura o fim de mês (31/08 + 6 meses vira 03/03; o `addMonths` dá 28/02). Com 1 e 12 meses o efeito era raro. Com 3 e 6 meses passa a acontecer todo ano: 30/11 + 3 vira 02/03, 31/08 + 6 vira 03/03. A empresa ganha até 3 dias grátis, e o próximo `periodStart` (que sai de `currentPeriodEnd`) desliza para a frente de forma permanente. Também usa o fuso do servidor, não o da empresa. O `periodEnd` da fatura (`addMonths`) deixa de bater com o `currentPeriodEnd` gravado.
- Cenário: assinatura semestral que vence em 31/08. Paga, e o período vai a 03/03 em vez de 28/02. A fatura seguinte nasce com `periodStart` 03/03.
- Correção (Vega): trocar por `addMonths(anchor, cycleMonths(...))`, a mesma função das outras três rotas, e cobrir com teste de fim de mês em 3 e 6 meses. Dívida anterior ao diff, ampliada por ele.

### I-2. Ciclo vira MENSAL sem aviso em três caminhos
O fallback `effectiveCycle` é seguro: nunca cobra preço errado nem inexistente. Mas a assinatura continua marcada como trimestral/semestral/anual enquanto a fatura sai mensal, e o dono não é avisado.
- (a) `changePlan` (`service.ts:~612-649`) não confere se o plano novo oferece o ciclo atual da empresa. O downgrade agendado entra no `tick.ts:~329-336` e cai em mensal.
- (b) Corrida entre apagar o preço e trocar de ciclo: `updatePlan` (`admin-service.ts:~72-80`, `countLiveSubscriptionsInCycle`) faz leitura e depois escrita sem transação. `changeBillingCycle` (`billing-cycle.ts:24-31`) também. Se as duas rodam juntas, o `CYCLE_IN_USE` não pega e a assinatura fica num ciclo sem preço. A janela é de milissegundos e só o admin dispara o lado do preço.
- (c) `changeBillingCycle` valida contra o plano ATUAL, não contra o `pendingPlan` que o tick vai cobrar.
- Impacto: reclamação ou contestação ("eu contratei o trimestral"), não perda de receita.
- Correção (Vega): em `changePlan`, recusar ou avisar quando o plano novo não oferece o ciclo, e em `changeBillingCycle` validar também o `pendingPlan`. Para a corrida (b), fazer a contagem e o `plan.update` na mesma transação com `SELECT ... FOR UPDATE` no plano, ou um avisador no tick quando `effectiveCycle` diferir do gravado.

## SUGESTÃO

### S-1. Coluna legada `appliesToCycle` não é espelhada (compatibilidade com a v1.7.5 durante o deploy)
- Onde: `prisma/migrations/20261013000000_ciclos_trimestral_semestral/migration.sql`, `coupons.ts` (`createCoupon` e `updateCoupon` só gravam `appliesToCycles`).
- A migration é aditiva e o backfill está certo. O default `'ANY'` e o CHECK antigo mantêm inserts da v1.7.5 válidos. Se um admin criar ou editar cupom na v1.7.5 depois da migration e antes da troca do container, o cupom nasce com `appliesToCycles = {}` (vale em todos) e o legado diz ANNUAL. O código novo lê só o array, então o cupom passaria a valer em todos os ciclos. Do outro lado, um cupom criado pela v1.7.7 aparece como `ANY` para a v1.7.5.
- A janela existe só enquanto os dois containers convivem. Basta não mexer em cupom nesse intervalo, ou parar o container antigo antes de subir o novo. Depois do deploy, conferir: `SELECT code FROM coupons WHERE "appliesToCycle" <> 'ANY' AND cardinality("appliesToCycles") = 0`.
- Remover a coluna legada numa migration futura, depois que a v1.7.5 sair de vez.

### S-2. Sem piso relativo no preço de ciclo
- Onde: `admin-service.ts:~58-63`. O teto (preço do período menor ou igual a mensal × meses) existe. O piso é R$ 1,00. Erro de digitação do admin (R$ 4,90 em vez de R$ 490,00) passa e vira cobrança irrisória para todas as novas assinaturas. É só admin, mas é dinheiro.
- Sugestão: confirmação na UI ou piso relativo (por exemplo, abaixo de 50% de mensal × meses pede confirmação explícita). A auditoria `plan.price_changed` já registra a mudança.

## Verificado e correto (sem achado)

1. **Preço sempre no servidor.** Nenhuma rota aceita preço ou valor do cliente. O ciclo vem de `z.enum(BILLING_CYCLES)`, e o preço, de `priceInvoice` / `loadInvoiceCharge` a partir do `Plan`.
   - Cadastro e cadastro Google: `signup/service.ts:187-190`. Ciclo explícito que o plano não oferece dá `INVALID_CYCLE`. O Google passa pelo mesmo `createAccount`.
   - Troca de ciclo: `billing-cycle.ts:24` (`planOffersCycle`, dono OWNER, rate limit).
   - Fatura do tick e reativação: `loadInvoiceCharge` com `effectiveCycle`, e a fatura grava `cycle` do cálculo (`tick.ts:~335`, `cancellation.ts:348`).
   - Pagamento: o período avança pelo `invoice.cycle` e não pelo da assinatura.
   - Ciclo que o plano deixou de oferecer cai em MONTHLY (nunca cobra preço nulo).
2. **Cupom por ciclo.**
   - Elegibilidade: `couponIneligibleReason` (`WRONG_CYCLE`) vale na prévia e na adoção. `loadInvoiceCharge` só aplica desconto se plano e ciclo são aceitos.
   - Gasto do ciclo: `consumeCouponCycleInTx` só roda com `discountCents > 0`, e a fatura sem desconto não gasta ciclo. Os decrementos são `updateMany` condicionais (`gt: 0`), na mesma transação da fatura.
   - Piso: `priceInvoice` limita o desconto a `bruto - MIN_CHARGE_CENTS`. AMOUNT e PERCENT nunca ficam negativos nem zeram, e `rawDiscount` usa `max(value, 0)`.
   - Resgate atômico: `claimCouponRedemption` (UPDATE condicional) mais o único (cupom, empresa) no `CouponRedemption`.
   - Troca para ciclo não aceito: o cupom fica pausado e sem desconto, e volta ao voltar o ciclo. Não há como obter desconto fora dos ciclos do cupom.
   - Admin: `updateCoupon` trava tipo, valor, duração e ciclos após o primeiro resgate. Zod limita o array a 4 itens do enum, e o serviço valida de novo.
3. **`CYCLE_IN_USE`.** Conta assinaturas não canceladas, no plano atual ou no `pendingPlan`, e só barra quando `input[field] === null`. Veja I-2(b) para a corrida.
4. **Períodos e relatórios.**
   - MRR: `mrrContributionCents` = preço do período ÷ meses do ciclo efetivo.
   - Régua e e-mail: textos por ciclo vêm de conjunto fechado (`cycleLabel`).
   - CSV: a coluna "Ciclo" vem de `cycleTitle(asBillingCycle())`, valor fixo (sem texto livre), e `csvLine` já neutraliza fórmula.
   - Períodos: veja I-1.
5. **`/cadastro/google`.** A página não monta `MetaTracking` e o formulário não chama `trackPixel`. O comentário da regra A-1 está no `page.tsx`. `previewSignupCouponAction` mantém recusa única (`PUBLIC_COUPON_REFUSAL`) para qualquer `COUPON_*`, com rate limit de 20 por 10 min por IP. O cadastro Google também converte `COUPON_*` na mesma resposta única.
6. **Migration 20261013000000.**
   - Colunas novas são anuláveis e o CHECK de preço exige `> 0`.
   - Os CHECKs de ciclo foram ampliados com o mesmo nome. Os dados existentes continuam válidos.
   - `appliesToCycles` é `NOT NULL DEFAULT '{}'`, e o backfill mapeia ANY, MONTHLY e ANNUAL corretamente.
   - O CHECK do array usa `<@` e `array_position(..., NULL) IS NULL`, que barra elemento NULL dentro do array. A coluna não é nula. O teste de integração `ciclos-schema` cobre isso.
   - O `DOWN.sql` existe e avisa do que precisa ser convertido antes. Os locks do DROP e ADD CONSTRAINT são curtos nas tabelas atuais.
