---
name: config-plataforma-em-abas-rotas
description: /admin/configuracoes virou 7 rotas-aba (layout com TabNav + aviso de alteração não salva); armadilhas de teste e de sed
metadata:
  type: project
---

Cada aba é rota própria (`/admin/configuracoes/{geral,whatsapp,automacao,pagamentos,email,login,marketing}`), layout em `configuracoes/layout.tsx` + `config-shell.tsx` (client: título "Configurações · X", `TabNav` de links com `aria-current`, diálogo de alteração não salva via `dirty-forms.tsx`). Fonte única de ids/hrefs: `config-tabs.ts` (`configTabHref`).

**Why:** pedido do dono (2026-10-03): rotas em vez de `?aba=`, cada aba carrega só seus dados.

**How to apply:**
- Link novo para config: usar `configTabHref(...)`, nunca `/admin/configuracoes` solto (só redireciona para Geral, perde a âncora).
- Ponto de atenção da aba vem do layout (não re-renderiza ao trocar de aba): formulários chamam `router.refresh()` após salvar.
- Formulário novo numa aba: `useReportDirty(id, dirty)` para entrar no aviso. Menu lateral/Voltar não passam pelo aviso (só `beforeunload`).
- Heading de card com HelpButton dentro: nome acessível não é exato; E2E usa `exact:false`.
- Botões "Salvar" por índice (`.first()/.nth(1)`) quebravam ao dividir a página: cada aba tem o seu.
- `sed 's#a#b#flag'` com `#` dentro do texto vira flag `w` e cria arquivo solto na raiz: usar python para trocar texto.
- `loading.tsx` de pasta com layout que tem cabeçalho não pode repetir PageLoading (duplica título): esqueleto só do conteúdo, um por aba.
