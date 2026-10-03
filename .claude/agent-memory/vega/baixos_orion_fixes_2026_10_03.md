---
name: baixos_orion_fixes_2026_10_03
description: Correções dos BAIXOS do Órion (S3 lookup, chave do backup, auditoria, teto da lista de espera, autoreply atômico) e armadilhas
metadata:
  type: project
---

- S3: `requestHandler: { httpsAgent }` com `createGuardedLookup` (s3-endpoint.ts); sem importar @smithy. Lookup do Node pode vir com `all:true` (autoSelectFamily): tratar os dois formatos.
- `requireProof` (two-factor/service) agora exportada; trocar chave do backup pede senha OU código.
- B-6: `logger.error` já alimenta o monitor de erros; a causa raiz era `errorMessage` ausente (campo `error` é descartado pela captura), então tudo caía num grupo só. Colocar o código da ação em `errorMessage`, nunca o texto cru do banco.
- Teto da lista de espera: vagas numeradas em ProviderEvent (`tenant:hora:n`, skipDuplicates). Faxina apaga linhas > 3h por createdAt: teste com data futura apaga as próprias linhas.
- `pg_advisory_xact_lock` devolve void: usar `$executeRaw`, `$queryRaw` quebra ("deserialize column of type void"). `withBlockingAdvisoryLock` em src/lib/db/advisory-lock.ts.
- `tsc` mostrou erros em src/lib/auth.ts (tipos {} vs string) vindos do upgrade de dependências do Vulcano, não deste trabalho.
