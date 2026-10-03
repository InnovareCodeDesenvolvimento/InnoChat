---
name: audit-orion-final-fixes
description: Correções da revisão final do Órion (2026-10-02): auditoria sem nome de cliente, texto do admin oculto ao dono, teto de erros do navegador, backup sem cifra recusado
metadata:
  type: project
---

- **Auditoria não guarda nome de cliente (LGPD).** Agenda/lista de espera gravam só o serviço no resumo e o `targetId` (agendamento / waitlist_entry). `resolveClientNames` em `audit/queries.ts` resolve o nome pelo contato vivo na leitura (`clientName`); anonimizado mostra "Cliente sem nome" (mesma `computeDisplayName` da lista de clientes). Ação nova que mexa em cliente: targetId = entidade que aponta para o Contact, nunca o nome no summary/changes.
- **Dono não vê texto livre do admin:** em `runQuery`, escopo da empresa zera `changes` de linhas PLATFORM_ADMIN. O Admin continua vendo (motivo da baixa).
- **Filtro por ator na empresa** só busca membros dela e exclui PLATFORM_ADMIN (senão o dono descobre o admin pelo e-mail).
- **Erros do navegador:** teto 300 grupos OPEN CLIENT; acima disso, fingerprint fixo `client-overflow` só conta. Manutenção resolve OPEN CLIENT parado há 30 dias.
- **Backup:** `restore-db.sh` exige `--aceitar-sem-cifra` para arquivo sem marca INNOBKP; `verifyLatestBackup` reprova cópia sem cifra quando já existe chave.
- **Cadastro:** recusa de cupom vira COUPON_INVALID com `PUBLIC_COUPON_REFUSAL` (em billing/coupons.ts). `adoptCouponInTx` continua detalhado (painel do dono usa).
- **URLs na auditoria:** `sanitizeChanges` limpa campos terminados em url/endpoint (sem usuário, senha, query).
- **Armadilha de ferramenta:** heredoc do Bash des-escapa `\n` e `\\` dentro de strings de código (quebrou 2 testes); usar Edit/Write para trechos com barras e conferir com tsc.
- **Armadilha de teste:** suítes de waitlist (e `billing-tick` suspensão) dependem da hora: fora de 8h-21h falham 4+1 testes por causa do relógio, não por regressão. Teste novo de cadastro não pode deixar plano `active:true` com sortOrder menor que os outros (vira o plano padrão do cadastro e quebra os testes seguintes).
