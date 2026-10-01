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
- Demo do celular reaproveita `PhoneFrame`/`ChatDoodle`/`ChatInputBar`/`StatusBarTime` de `whatsapp/phone-mockup.tsx` (PhoneFrame aceita width/height; painel intocado, diff de pixels 0). Visão do CLIENTE: cliente = saída verde, bot = entrada branca (o painel mostra a visão da EMPRESA, invertida de propósito). Chat com `overflow-y-auto` + `scrollTo` no contêiner (nunca scrollIntoView). "digitando..." no cabeçalho.
- Logo: `public/marca/innochat-balao.png` (96px, recorte de inno-logo.png 798,292,300x292). sharp: resize roda ANTES de extend; fazer em etapas.
- Prazo da demo: `DEFAULT_CANCEL_MIN_LEAD_MIN` (120) conferido por teste contra o `@default` do schema.
- Print de página inteira: JPEG q82 via sharp (<1 MB). Rota temporária para medir componente do painel deve ficar em `(public)` (cada grupo tem seu root layout) e logada.
- HMR no meio de script Playwright reinicia a demo; não editar arquivos durante medição.
- Inno ao lado do celular (`hero-stage.tsx`, client): PhoneDemo recebe render-prop `companion({mode,typing})` e renderiza dentro do `.demo` (relative, w-fit => bottom-0 = pé do aparelho). Imagem `inno-apresentando.webp` (334x600, recorte x0..698 do Mascote_Logo.png) tem a mão apontando p/ ESQUERDA, por isso o Inno fica à DIREITA do celular (sem espelhar o logo do peito). `--inno-h` por breakpoint (150 mobile abaixo do aparelho / 260 md / 220 lg / 300 xl); wrapper com `pr` desloca o celular p/ a esquerda. Card "Lembrete" (2xl) foi p/ a esquerda do celular; precisa `w-max`.
