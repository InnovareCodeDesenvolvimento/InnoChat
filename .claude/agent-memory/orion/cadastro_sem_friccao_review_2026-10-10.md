---
name: cadastro-sem-friccao-review-2026-10-10
description: Revisão do cadastro sem fricção (verified-login, cupom SSR, intent://, reprice do teste); sem CRÍTICO, 1 ALTO (convite a conta pré-registrada); padrões
metadata:
  type: project
---

Sem CRÍTICO. Prova `login-verified` não é forjável (HMAC por finalidade, 60 s, só no servidor); login por senha nunca exigiu e-mail verificado, então abrir sessão no cadastro não cria permissão nova (só `createWhatsappInstanceAction` exige `requireVerifiedEmail`).

Achados:
- ALTO: `inviteTeamMember` (signup/service.ts) reaproveita User existente e cria Membership ANTES do aceite; conta pré-registrada com e-mail alheio (agora sem fricção) herda acesso ao tenant que convida. `acceptInvite` troca senha mas não sobe `sessionVersion` (o Google equivalente sobe).
- MÉDIO: selo de cupom SSR em /cadastro?cupom= sem rate limit (oráculo de código; a prévia pública tem 20/10 min); WhatsApp de terceiro (só 1 msg/dia POR TENANT, sem bloqueio global por número); VOID por reprice com Pix velho pago = só `paidWhileVoidAt`, sem estorno/aplicação automática; `changePlanAction` sem rate limit e agora cancela/gera Pix no MP.
- BAIXO: `publicHost` em cadastro/page.tsx usa x-forwarded-host cru (política I3 manda usar publicBaseUrl); honeypot `website` pode ser autopreenchido e vira sucesso falso silencioso; rate limit 5/h por IP em memória + CGNAT/Cloudflare (TRUSTED_PROXY_HOPS=1).

**Why:** padrão recorrente: Host/XFH cru em links (já em google_login_review) e rate limit ausente em rotas públicas novas.
**How to apply:** em toda feature pública nova, checar rate limit por IP em CADA leitura que consulta o banco por input do visitante, e se o link usa getStoredPublicBaseUrl.
