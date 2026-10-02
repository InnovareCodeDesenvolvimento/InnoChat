# Revisão de segurança FINAL: pacote de 8 melhorias (fdece65..HEAD, 1aeff4d)

Revisor: Órion (somente leitura). Data: 2026-10-02. Escopo: correções da Onda 1 (0eacac8), lista de espera, relatórios e comissão, backup cifrado, auditoria, dependências.

**Veredito: LIBERA a publicação.** Nenhum CRÍTICO, nenhum ALTO. Os dois ALTO da Onda 1 (A-1, A-2) estão resolvidos. Há 3 MÉDIO e 9 BAIXO; recomendo tratar o M-1 (motivo da baixa manual visível ao dono da empresa) antes ou logo após o deploy, porque a correção é pequena. Nenhum deles bloqueia.

Contagem: CRÍTICO 0, ALTO 0, MÉDIO 3, BAIXO 9.

## O que NÃO foi provado
- Nada foi executado: leitura de código, diffs e testes lidos, mas não rodei a suíte nem Postgres. Os testes citados (`security-onda1-fixes`, `onda1-qa-ataques`, `backup`, `audit`, `waitlist`, `reports-commissions`) foram LIDOS como evidência de intenção, não executados por mim.
- A renovação do `sv` por `unstable_update` dentro de `runWithSessionRefresh` foi avaliada por leitura (AsyncLocalStorage propaga pelos `await`); não confirmei o comportamento do Auth.js em runtime.
- DNS rebinding do S3 e o comportamento do GCM em fluxo foram raciocinados, não explorados.
- M-1 da Onda 1 (login com Google sem 2FA) não foi reaberto nesta revisão (decisão do dono pendente na época).
- `npm audit` rodou agora, com a base de advisories de hoje.

---

## 1. Correções da Onda 1: confirmação

| Achado | Estado | Evidência |
|---|---|---|
| A-1 token Google na URL com Pixel | RESOLVIDO | `cadastro/google/page.tsx` não monta mais `MetaTracking`; o formulário não dispara `trackPixel` nem manda `metaEventId`. `/cadastro` usa `stripQuery`. Teste lê os fontes e proíbe a volta. |
| A-2 2FA só no layout | RESOLVIDO | `requirePlatformAdmin` (`guards.ts:30-47`) relê `totpEnabledAt` e lança `TWO_FACTOR_SETUP_REQUIRED`; `requireTenantMember` faz o mesmo para `twoFactorRequired`. As actions de 2FA usam `requireSessionUser`, então a pessoa ainda consegue ativar. |
| M-2 /api/client-errors | RESOLVIDO EM PARTE | Corpo lido com teto mesmo em chunked (`readBodyWithLimit`), orçamento CLIENT separado do SERVER (30/min, 2 simultâneos), texto do cliente fora do e-mail, grupos RESOLVED/IGNORED somem em 90 dias. Resta o teto de grupos OPEN: ver M-3 abaixo. |
| M-3 Pixel retenção/consentimento | RESOLVIDO | `meta-signup`/`meta-capi` apagados em 180 dias (`maintenance/tick.ts`); `isPixelActive` relê o consentimento na hora; `revokePixel`. |
| M-4 enumeração de cupom | RESOLVIDO NA PRÉVIA; resta o cadastro | `previewSignupCouponAction` devolve uma única mensagem. `signUpAction` ainda deixa passar `COUPON_EXPIRED/EXHAUSTED/WRONG_PLAN` (ver B-4). |
| M-6 S3 | RESOLVIDO, com risco residual | https obrigatório (Zod e `checkS3EndpointShape`), sem userinfo, IP privado/CGNAT/metadados/IPv6 mapeado recusados, resolução DNS antes de testar e de cada backup, erro cru do SDK só no log. Resta DNS rebinding (B-1). |
| SQL de fuso (contact-queries) | RESOLVIDO | `botPausedUntil > ${now.toISOString()}::timestamp`. `startsAt` do relatório é `timestamptz`, compara direto sem risco. |
| B-1 restore com senha em argumento | RESOLVIDO | `restore-db.sh` tira a senha da URL e usa `PGPASSWORD`; eco só do destino sem senha. |
| B-2 dump temporário | RESOLVIDO | pasta 0700, arquivo 0600 (`runBackup`, `downloadDriveFile`, `decryptFile`, `mktemp -d` + `chmod 700` no script). |
| B-4 2FA sem aviso e sem derrubar sessões | RESOLVIDO | `sessionVersion + 1` na confirmação, e-mail de aviso ao ligar/desligar/resetar, log de auditoria. |
| M-7 dump sem cifra | RESOLVIDO (ver seção 4) | |
| B-7 estado em memória duplicado por bundle | RESOLVIDO para o que a Vega citou | `globalState` em rate-limit, idempotência, cache de `sv`, desafios de 2FA, timer de alerta, orçamentos do monitor. Premissa de 1 processo segue valendo. |

### Pontos novos pedidos pela Vega

- `src/modules/auth/session-refresh.ts` e `src/lib/auth.ts:230-238`: correto. A permissão de renovar o `sv` vive num `AsyncLocalStorage` aberto só dentro da rota `/api/two-factor/confirm`, depois de `requireSessionUser` e da confirmação do TOTP. Um `POST /api/auth/session` com `update` vindo do navegador roda em outro contexto assíncrono: `isSessionRefreshAllowed` dá falso e cai no caminho normal, que confere o `sv` no banco e invalida o token revogado. A comparação por `userId` impede que a permissão de um usuário valha para o token de outro. Não achei ressurreição de token revogado.
- `src/modules/backup/s3-endpoint.ts`: lógica de bloqueio sólida (testa `0.0.0.0/8`, loopback, CGNAT, link-local, 192.0.0.0/24, benchmark, multicast/reservado, IPv6 ULA/link-local/multicast, `::ffff:` mapeado; recusa nomes sem ponto e `.local/.internal/.lan/.localhost`). Residual em B-1.
- `POST /api/two-factor/confirm`: exige sessão (`requireSessionUser`), `Origin` igual ao host quando presente (ausente passa, como no monitor; o cookie de sessão SameSite e o `Origin` que o navegador sempre manda em POST cross-site cobrem CSRF), corpo limitado a 1 KiB, `Cache-Control: no-store`, rate limit por usuário herdado de `confirmTwoFactorSetup`, nada de segredo em log. A transação é condicional, então confirmações simultâneas não geram dois conjuntos de códigos.
- `src/lib/global-state.ts`: `Symbol.for` em `globalThis`, mesmo padrão do `prisma.ts`. Sem risco novo; qualquer código no processo lê o estado, o que já é verdade para o resto. Mantém a premissa de processo único.

---

## 2. Lista de espera

Avaliado e correto:
- Rotas internas `/api/internal/v1/waitlist`, `/[id]/respond`, `/[id]/leave` e `contacts/[contactId]/waitlist` passam por `resolveInternalRequest` (instância autenticada resolve o `tenantId`); toda leitura e escrita vai por `forTenant(ctx.tenantId)`. `contactId` e `entryId` de outra empresa dão NOT_FOUND/`OFFER_GONE`. Dentro da empresa, `contactId` vem do corpo, mesmo modelo de confiança dos demais endpoints do bot (o n8n é o cliente autenticado).
- Tick `/waitlist/tick`: Bearer com `verifyInternalApiSecret` (hash), 401 sem segredo, idêntico aos outros ticks.
- Aceite/reserva concorrentes: `WAITING->OFFERED`, `OFFERED->ACCEPTED`, `ACCEPTED->FULFILLED` são `updateMany` condicionais; índice único parcial resolve o mesmo horário para duas pessoas; `idempotencyKey: waitlist:<id>` e recuperação de `ACCEPTED` preso no tick.
- Override do claim: `findPendingWaitlistOffer` exige `offeredAt > lastInboundAt` (a oferta foi a última coisa dita), `contactId` fixo e tenant fixo; só fluxo v2, nunca com atendente (`HUMAN`) e nunca após retomada de humano. "sim/não" atrasado só vale por 6 h e só se a mensagem inteira for sim/não (`isWaitlistAnswerText` compara com `normalizeText`, sem regex, sem ReDoS).
- Teto de envio: no máximo 10 filas ativas por contato, 8 candidatos por gatilho, 1 oferta por horário liberado, uma oferta aberta por pessoa, bot pausado e atendimento humano pulam, janela 8h-21h respeitada (`isInsideSendWindow`), `sendTextToContact` com `RATE_LIMITED`.
- Marca `waitlist-deferred`: uma linha por empresa (único `(provider, providerEventId)`), consumida por `deleteMany` (quem apaga leva), sem dado pessoal (`payload: {}`), no máximo 200 empresas por rodada.
- Painel: `requireTenantMember` + `assertTenantCanWrite`; `createWaitlistEntry` valida contato, serviço e profissional pelo tenant.

Achados:
- B-7 (BAIXO), `src/modules/waitlist/respond.ts:75-97`: se `createAppointmentManual` falha com erro inesperado (banco fora, timeout), o `catch` devolve a pessoa a `WAITING` e apaga a oferta, mas não chama `passToNext`; o horário fica sem ser reoferecido até alguém liberar outro. Não é vazamento nem escalada, só horário perdido. Correção: no ramo de erro desconhecido, também passar o horário ao próximo.
- B-8 (BAIXO), sem teto por empresa/hora de ofertas automáticas: um funcionário que cancela 100 horários numa hora dispara até 100 mensagens a pessoas diferentes. Só quem entrou na lista recebe, então o risco de denúncia é baixo; vale um teto por empresa/hora no `reserveAndSend`.

---

## 3. Relatórios e comissão

Avaliado e correto:
- `reports-sql.ts`: `Prisma.sql` parametrizado, `a."tenantId"` é o primeiro filtro e vem de `requireTenantMember`, joins de `services` e `professionals` casam `tenantId`; `professional_services` não tem `tenantId`, mas a chave (profissional, serviço) já está presa ao tenant pelos joins anteriores. Período vem de `resolveReportRange` (teto 366 dias).
- Rota CSV: `requireTenantMember(slug, ["OWNER"])` (STAFF 403, não-membro 404), Zod, `no-store`, `nosniff`, nome do arquivo montado só com datas validadas, todas as células passam por `csvCell` (neutraliza `= + - @ \t \r` com apóstrofo; testei a regex lendo `src/lib/csv.ts`).
- `omit` global em `prisma.ts` tira `commissionPct`, `commissionPctSnapshot` e `commissionCentsSnapshot` de qualquer leitura sem `select`; quem precisa (`commissions.ts`, `appointment-snapshot.ts`, `reports-sql.ts`) lê com `select` explícito. A tela do profissional chama `getCommissionConfigAction` (OWNER): STAFF recebe FORBIDDEN e a tela nem monta o cartão. `grep` de `commissionPct` mostra só os 6 arquivos esperados.
- `setProfessionalCommission`: prova o profissional por `forTenant`, recusa serviço não vinculado (conta antes de gravar), valores 0-100 com 2 casas, transação, e a auditoria só grava o que mudou e só o dono do tenant a vê.
- Reabrir apaga a foto de valores, concluir fotografa dentro da mesma transação do `updateMany` condicional.

Sem achados novos neste bloco. Observação: o `as unknown as PrismaClient` em `prisma.ts` esconde a mudança de tipos; garanta que o teste de STAFF (já existe em `reports-commissions.integration.test.ts`) siga na CI, porque ele é o que prova que o `omit` vale também dentro de `$transaction`.

---

## 4. Backup cifrado

Avaliado e correto:
- Formato: AES-256-GCM, IV de 12 bytes aleatório por arquivo, marca+versão+impressão digital (11 bytes) autenticados como AAD, IV como nonce, tag de 16 bytes no fim. Troca de impressão digital, versão ou corte do arquivo reprova (a tag não confere). Limite de 2^36-64 bytes por IV respeitado. Chave de 32 bytes validada.
- Decifragem em fluxo: o fluxo só entrega texto claro ao arquivo de saída, e `decryptFile` apaga a saída em qualquer erro; em `verifyLatestBackup` o `pg_restore --list` só roda depois de `decryptFile` resolver, e `restore-db.sh` só chama `pg_restore` depois de o `decrypt-backup.mjs` terminar com sucesso (o script grava em `.parcial-<pid>` e só renomeia no fim). O `pg_restore` nunca vê byte não autenticado. A tag só confere no fim (propriedade do GCM), por isso a regra "usar só depois do fim" está bem implementada nos dois lados.
- Chave: guardada com `encryptSecret` (AUTH_SECRET), impressão digital conferida na leitura, e-mail ao gerar/trocar sem a chave, auditoria só com impressão digital, resposta com `Result` sem log da chave.
- `generateBackupKeyAction`: devolve a chave inteira só na resposta que a gerou. Chamada de novo sem `replace` recusa (`BACKUP_KEY_EXISTS`); com `replace` exige a frase `GERAR NOVA CHAVE` conferida no servidor e gera uma chave NOVA, nunca revela a existente. Troca é condicional à impressão digital anterior (dois cliques não geram duas chaves). Não há caminho para ler a chave de volta.
- Scripts: `decrypt-backup.mjs` não aceita chave por argumento (arquivo ou `BACKUP_KEY`), não sobrescreve saída, 0600, código de saída distinto. `restore-db.sh` decifra para pasta 0700 com `trap` de limpeza. CI cobre chave errada, arquivo adulterado e dump em claro ausente.
- Limite de desenho a documentar: a chave fica no servidor (necessária para o backup agendado) cifrada com o `AUTH_SECRET`. A cifra protege contra vazamento do bucket/Drive, não contra comprometimento do servidor nem de quem tenha o `AUTH_SECRET` mais o banco. Trocar o `AUTH_SECRET` torna a chave guardada ilegível (o sistema avisa e pede gerar outra; a cópia do dono continua abrindo os arquivos antigos).

Achados:
- B-2 (BAIXO), `scripts/restore-db.sh:89-103` e `service.ts` (`verifyLatestBackup`): um arquivo SEM a marca `INNOBKP` é aceito como dump em claro, sem aviso. Quem tem escrita no bucket pode trocar o `.dump.enc` mais recente por um `.dump` forjado: o `pg_restore` de um dump hostil executa SQL no banco de destino, e a verificação semanal o aceita como "legado". Correção: no script, exigir flag explícita (`--aceitar-sem-cifra`) para dump em claro; na conferência do sistema, depois da primeira cópia cifrada, recusar cópia mais recente sem cifra (já recusa se o nome termina em `.enc` sem marca; falta recusar quando a anterior era cifrada).
- B-5 (BAIXO), `backup/actions.ts` (`generateBackupKeyAction` com `replace`): sessão de admin sequestrada (já com 2FA no login) pode trocar a chave sem pedir senha ou código de novo; o dano é limitado (as cópias antigas seguem abrindo com a chave que o dono guardou) e há e-mail. Pedir senha ou código TOTP para `replace`.

---

## 5. Auditoria

Avaliado e correto:
- `sanitize.ts`: redige por NOME de campo (`enc$`, senha, token, secret, credential, key$, chave, hash$, accesskey...) nos dois lados do de/para, encurta valores a 200 caracteres, teto de 7000 bytes com `_omitidos`, e o banco tem CHECK de 8192 bytes. Os chamadores passam `{de:null,para:null}` para segredos trocados e mascaram contatos de cobrança ("informado/vazio"). IP guardado truncado (/24 e /48), só o Admin o vê.
- Isolamento: `listTenantAudit` fixa `tenantId` vindo do guard (`requireTenantMember(slug, ["OWNER"])`), `allowTenantQuery: false`, nunca da URL; a página ainda confere a membership e o papel. `listAdminAudit` exige `requirePlatformAdmin` (com 2FA agora). Ações da plataforma gravam `tenantId: null` e só o Admin as vê.
- Trigger append-only barra `UPDATE`; FK do ator ausente de propósito (sobrevive a exclusão de usuário).
- Admin como "Equipe InnoChat" para o dono funciona em `runQuery` (`hidePlatformAdminName`).

Achados:
- **M-1 (MÉDIO), texto interno do admin visível ao dono da empresa.** `src/modules/billing/admin-actions.ts` (ação `markInvoicePaidManuallyAction`) grava `invoice.marked_paid_manually` com `tenantId` da empresa e `changes: { motivo: data.reason }`; `company.suspended`, `company.reactivated`, `company.trial_extended` e `two_factor.reset_by_admin` também levam o `tenantId`. `listTenantAudit` (`queries.ts:166`) filtra só por `tenantId`; `platformOnly` em `labels.ts:99-102` só esconde a área do dropdown (`historico/page.tsx:50`, `audit-log-view.tsx:96`), não as linhas. Cenário: o admin escreve "cliente reclamou, desconto combinado com o João" no motivo; o dono da empresa lê isso em Configurações > Histórico. Correção: ou gravar o motivo numa linha só da plataforma (`tenantId: null`) e deixar na linha da empresa só "Deu baixa manual numa fatura de R$ X", ou excluir do `listTenantAudit` os prefixos `platformOnly` quando o ator é `PLATFORM_ADMIN` e o texto é livre. Decida se o dono deve ver "empresa suspensa" (transparência razoável) e separe isso do texto livre.
- **M-2 (MÉDIO, LGPD), nome de cliente final no resumo de uma tabela que não aceita UPDATE e guarda 5 anos.** `describe.ts` (`auditAppointmentAction`: "Criou o agendamento de Maria, Corte, 12/10 às 14:00") e `waitlist/actions.ts:waitlistLabel` ("Colocou Maria (Corte) na lista de espera") gravam o nome do cliente. A anonimização de contatos (pedido do titular e empresa CANCELED há 90 dias) não alcança o `audit_logs`, e o trigger proíbe corrigir; só o `DELETE` por idade (5 anos) ou o CASCADE da empresa remove. Os clientes podem ser menores de idade. Correção: não gravar o nome; gravar só `targetId` e serviço/horário (a tela do histórico já resolve o nome lendo o contato vivo, que some quando anonimizado), ou guardar o primeiro nome. Se quiser manter o texto, permitir um caminho de anonimização controlado (por exemplo, `UPDATE` permitido só com uma variável de sessão dedicada e só em `summary`) e chamá-lo na anonimização.
- Opinião sobre os textos livres do de/para: mensagem do bot (até 200 caracteres, texto da própria empresa, visível só ao dono dela) é aceitável; e-mail de convite em `team.invited` é dado pessoal de terceiro por 5 anos, aceitável com base em legítimo interesse mas prefira mascarar (`j***@dominio`) já que o `targetId` do vínculo resolve o resto; motivo de baixa é o M-1; nome de cliente é o M-2. Campos de URL do admin (`evolutionApiUrl`, `n8nWebhookBaseUrl`) entram em claro: tire usuário e query antes de gravar (B-9).
- B-3 (BAIXO), `queries.ts:buildWhere` (filtro por ator): a busca consulta `User` em TODA a plataforma por e-mail ou nome. No histórico da empresa a resposta é igual para "usuário não existe" e "usuário existe mas não agiu aqui" (vazio), então não há oráculo de existência. Mas o dono pode digitar o e-mail ou nome de um admin da plataforma e, se as linhas "Equipe InnoChat" aparecem, descobre quem é o admin que mexeu na conta dele, anulando a máscara. Correção: no escopo da empresa, restringir a busca aos usuários com `Membership` naquele tenant e excluir os que têm `actorRole PLATFORM_ADMIN`.
- B-6 (BAIXO), integridade: o trigger só cobre `UPDATE`; o `purgeOldAuditLogs` roda como o mesmo papel do app, então um app comprometido (ou um SQL injection futuro) apaga o histórico, e `TRUNCATE`/`DROP TRIGGER` não são barrados. Além disso `recordAudit` engole erro de propósito: uma ação sensível pode acontecer sem registro, com apenas um `logger.error`. Sugestão: papel de banco separado só com `INSERT/SELECT` e a purga por papel dedicado; encadeamento por hash se a auditoria for virar prova; alerta quando `audit.record_failed` aparecer.

---

## 6. Achados residuais da Onda 1 (resumo)

- **M-3 (MÉDIO, residual do M-2 da Onda 1), grupos de erro OPEN do navegador sem teto total.** `capture.ts` limita a 30 gravações/min do navegador e `service.ts` só apaga grupo RESOLVED/IGNORED. Quem rotaciona mensagem (a impressão digital muda) cria até ~43 mil grupos OPEN por dia, que nunca saem e inundam Admin > Erros e o disco. Correção: teto de grupos OPEN com `source = CLIENT` (por exemplo 500; acima disso só conta num grupo agregado "Outros relatos do navegador") ou expirar OPEN CLIENT sem ocorrência recente (30 dias).
- B-1 (BAIXO), DNS rebinding no S3: `checkS3EndpointResolved` resolve o nome e o SDK resolve de novo ao conectar. Um DNS do atacante pode responder público na checagem e 169.254.169.254 na conexão. Exige admin com 2FA, e o erro cru não volta à tela, então só há efeito cego (sem leitura). Para fechar: injetar um `lookup` no agente HTTP do `S3Client` (`NodeHttpHandler`) que aplica `isPrivateOrReservedIp` ao endereço realmente usado, em vez de resolver antes.
- B-4 (BAIXO), `signUpAction` (`signup/service.ts:231`, `adoptCouponInTx`): ainda devolve `COUPON_EXPIRED/EXHAUSTED/WRONG_PLAN` com mensagens distintas no cadastro público (5 tentativas/hora/IP). Mapear para `COUPON_INVALID` com a mesma mensagem da prévia.
- B-9 (BAIXO), auditoria de URL de configuração em claro (ver seção 5).

---

## 7. Dependências (`npm audit --omit=dev`, 2026-10-02)

- Contagem: 7 vulnerabilidades (6 altas, 1 crítica). Igual à revisão anterior. `package.json` não mudou desde `fdece65` (nenhuma dependência nova).
- O que mudou: a lista de advisories do `nodemailer` cresceu (agora 8 itens, antes citei 2). Os novos relevantes em tese: `raw` ignorando `disableFileAccess` (GHSA-p6gq-j5cr-w38f), `resolveContent` legado (GHSA-8m3c-c648-2xjj), cache DNS global com `servername` TLS reaproveitado entre transportes (GHSA-6vj9-mwq6-2f5v), DoS por parser de endereço. Exposição no projeto: as mensagens são montadas por modelos próprios (`src/lib/email/*`), sem `raw` nem `resolveContent` com dado de usuário, e há uma única configuração SMTP da plataforma; baixo risco prático, mas o `Testar conexão` do admin cria um transporte com host digitado (`connection-tests.ts`), mantendo o item do DNS global na lista a atualizar.
- `next` 16.3.4 continua com o RCE em `next/og` (`GHSA-vcvr-r3jv-pc5j`); `grep` de `next/og`/`ImageResponse` em `src` segue vazio, sem exposição. Atualizar para 16.3.8 mesmo assim.
- `deepmerge-ts` (via `prisma`/`@prisma/config`): só em ferramenta de CLI, sem exposição em runtime.
- Ação: atualizar `next` e `nodemailer` num commit à parte, com `npx npm@10.9.9` para o lockfile (regra do projeto).
