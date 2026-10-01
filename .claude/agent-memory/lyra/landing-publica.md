---
name: landing-publica
description: Landing de "/" (src/components/landing): decisões, armadilhas e o que está desligado (prova social)
metadata:
  type: project
---

Landing em `src/app/(public)/page.tsx` + `src/components/landing/*`. Hero/painel/CTA em fundo escuro (`.auth-brand-bg`) porque a arte do Inno é feita para fundo escuro.

- Página `force-dynamic` (build sem banco quebra com revalidate); planos via `getLandingPlans` (cache 60 s, erro => null => seção sem preço).
- Demo do celular: texto do bot sai de `renderMessage` + `DEFAULT_BOT_TEXTS_V2` (nunca copiar texto). HTML traz tudo visível; CSS esconde só com `no-preference` e `data-mode`.
- Armadilha: Playwright `locator.scrollIntoViewIfNeeded` nunca "estabiliza" elemento com animação float; usar `evaluate(scrollIntoView)`.
- Armadilha: dois `next build` simultâneos (um em background) quebram com "next/font/google queries"; build um por vez.
- Prova social: `social-proof.tsx`, `TESTIMONIALS = []` => não renderiza.
- Cadastro ignora `?plano=` (backend aceita `planCode`, form não passa).
