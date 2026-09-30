# Memória — Íris (QA/testes) — InnoChat

- [Playwright multi-processo: prefixo de fixture não pode vir de Date.now() no módulo](e2e_playwright_multiprocess_fixture_ids.md) — global-setup e specs rodam em processos diferentes.
- [Prisma Client fica desatualizado depois de migration sem `prisma generate`](prisma_client_stale_after_migration.md) — causou 500 mascarado.
- [Plano do tenant de seed já está no limite de profissionais](seed_tenant_plan_limit_e2e.md) — E2E precisa de override temporário.
- [Suíte E2E do painel: onde está e como rodar](e2e_suite_layout.md) — playwright.config.ts, tests/e2e/**, screenshots.
- [Log de bugs/gaps encontrados 2026-09-28](bugs_found_log.md) — Prisma Client desatualizado, gap de UI (bloqueio empresa inteira), investigação do flaky de concorrência.
- [Log de bugs 2ª rodada 2026-09-28](bugs_found_log_round2.md) — link de redefinir senha quebrado, diálogo de sucesso do WhatsApp some na 1ª conexão, causa raiz do teste de integração "cancelar fora do prazo" (bug do teste, não do produto).
- [getByLabel exact em campo required precisa do " *"](playwright_required_field_asterisk_label.md) — `Field` acrescenta asterisco ao label; `exact:true` sem ele nunca casa.
- [next dev: lock de instância única por pasta, não por porta](next_dev_single_instance_lock.md) — por que `/instalacao` (banco `innochat_test`) precisa de `playwright.instalacao.config.ts` sem `webServer`.
- [Rate limit de login (8/15min por e-mail) quebra specs com muitos re-logins](login_rate_limit_e2e.md) — reusar cookie de sessão em vez de logar de novo a cada teste.
- [Rate limit de cadastro (5/hora por IP) esgota entre rodadas](signup_rate_limit_e2e.md) — reiniciar `next dev` antes de CADA rodada, não só da primeira.
- [Testar arrastar-e-soltar (dnd-kit) na Agenda](dnd_kit_drag_testing.md) — mouse simulado, `scrollIntoViewIfNeeded`, checar resultado no banco em vez do pixel exato.
- [Mercado Pago não tem servidor fake possível (API_BASE fixo)](mercadopago_no_fake_server.md) — RATE_LIMITED é E2E real; MISSING_DOCUMENT só em integração (gateway injetado).
- [Achados da rodada C1 (2026-09-29)](bugs_found_log_round3.md) — nav dot invisível com grupo colapsado, `/termos` sem `revalidatePath`, pollution de dados antiga limpa.
- [Achados da rodada 2026-09-29 (notificações + espera)](bugs_found_log_round4.md) — tour intercepta clique, loading.tsx => 200 no notFound, sync n8n exige nó Webhook, drag flaky por autoscroll, overflow 360px.
- [Auditoria do bot 2026-09-30](bot_audit_2026_09_30.md) — simulador scripts/bot-sim, 17 bugs, armadilhas de ambiente
- [Simulador v2: I-0/I-1 (2026-09-30)](bot_v2_simulador_i0_i1.md) — baseline 37/24, cenários CA/API por tarefa, armadilhas de edição e de worktree
