# Plano de melhorias (aprovado pelo dono em 2026-10-02)

São oito itens aprovados. Este documento diz como cada um vai ser feito, quem faz e em que ordem. Ele é a referência dos briefings.

## Regras que valem para todos os itens

- **Segredos e configurações** (DSN, tokens, credenciais) são **cadastráveis no Admin**, cifrados no banco. Nada de variável de ambiente nova. No Easypanel só ficam `DATABASE_URL` e `AUTH_SECRET`.
- **Migrations**: só aditivas, rodam no boot. Na Onda 0 o Cronos faz o schema de todos os itens de uma vez, para os agentes paralelos não editarem o `schema.prisma` ao mesmo tempo.
- **Toda tela ou card novo**:
  - tem ajuda ⓘ com exemplo;
  - segue o `docs/guia-de-voz.md`;
  - tem paginação numerada se for lista longa;
  - é medido em 1440 e 390.
- **Sem pacote novo** sem aprovação do Atlas. O lockfile é do npm 10.
- **Cada entrega** passa por lint, typecheck, unit, integração, build sem banco, Órion e Íris. Depois vem a versão nova e o "pode publicar".

## Os oito itens

| # | Item | Abordagem | Dono |
|---|---|---|---|
| 1 | Monitoramento de erros | O dono pediu "Sentry ou similar". O Sentry exige DSN em variável de ambiente e configuração no build, o que fere a regra de não ter env nova. **Decisão do Atlas: monitor próprio "similar"**. Ele captura erros do servidor (`onRequestError` / instrumentação do Next e `logger.error`) e do navegador (error boundary e `window.onerror`, via rota com limite). Agrupa por assinatura, mostra a tela **Admin → Erros** (ocorrências, última vez, rota, versão, stack sem dado pessoal), alerta no sino e manda e-mail quando aparece erro novo. Se o dono quiser o Sentry depois, o DSN entra pelo Admin. | Vega |
| 2 | Backup automático + teste de restauração | **Igual ao Parque das Feiras** (`ParquedasFeiras/docs/BACKUP.md`): tela **Admin → Backup** com agendamento diário (hora de Brasília), retenção, alerta após X horas sem backup e destino **S3** ou **Google Drive** (conta de serviço ou OAuth). Credenciais cifradas. Botão "Fazer backup agora". Job de **CI que restaura**: semeia, faz dump, derruba o schema, restaura e confere. | Vulcano |
| 3 | Verificação em 2 etapas (2FA) | TOTP (Google Authenticator e similares) com códigos de recuperação. **Obrigatória para o admin da plataforma** e opcional, mas incentivada, para os donos. Entra no login por senha. O login pelo Google já tem a 2FA do próprio Google. | Vega |
| 4 | Registro de auditoria | Tabela append-only `AuditLog` com quem, papel, o quê, alvo, antes/depois resumido, IP e quando. Cobre agenda, preços e serviços, profissionais, equipe, plano/assinatura, suspensão/reativação, configurações, textos do bot e a 2FA. Telas: **Admin → Auditoria** (todas as empresas) e **Configurações → Histórico de alterações** (só da empresa, só o dono). Filtros e paginação. | Vega + Lyra (Onda 2) |
| 5 | Pixel do Meta + páginas por nicho | Pixel ID e token da **API de Conversões** cadastrados no Admin. Eventos PageView, Lead (início do cadastro), CompleteRegistration (cadastro feito) e Purchase (primeiro pagamento, pelo servidor via CAPI com dedup). Respeitar consentimento (banner LGPD simples). Páginas `/salao`, `/barbearia`, `/clinica-estetica`, `/consultorio`, `/pet-shop`, reaproveitando a landing com textos e exemplos do nicho, SEO próprio e sitemap. | Lyra (+ Vega na CAPI) |
| 6 | Plano anual com desconto + cupons | `Plan` ganha preço anual (ou % de desconto). A assinatura ganha ciclo mensal/anual. Cupom: código, % ou valor, validade, limite de usos, planos válidos e "só primeira fatura" ou "N meses". Aplicado no cadastro e na tela Assinatura. Admin cria e gerencia os cupons. A régua e o Financeiro respeitam o ciclo anual (MRR = anual / 12). | Vega + Lyra |
| 7 | Lista de espera / encaixe | O cliente entra na lista pelo bot quando não há horário no dia ou período desejado. Quando um horário abre (cancelamento ou remarcação), o bot oferece aos da lista em ordem, com prazo para aceitar. Painel: lista de espera por dia e profissional, com o "oferecer encaixe" manual. Mexe no motor do bot e no fluxo do n8n: simulador, probe no n8n real e "Publicar fluxo". | Vega + Lyra (Onda 2) |
| 8 | Relatórios | Faturamento por período, serviço e profissional (agendamentos concluídos × preço), ticket médio, taxa de faltas por profissional, **comissões** (percentual por profissional e/ou por serviço, cadastrável) e exportação CSV. Tela **Relatórios** no painel, só para o dono. | Vega + Lyra (Onda 2) |

## Ordem de execução

- **Onda 0** (Cronos): schema de todos os itens numa vez só. É a base para não haver conflito.
- **Onda 1**, em paralelo:
  - 1 erros (Vega);
  - 2 backup (Vulcano);
  - 3 2FA (Vega);
  - 5 pixel e nichos (Lyra);
  - 6 anual e cupons (Vega).
- **Onda 2**, em paralelo:
  - 4 auditoria, depois da Onda 1, para registrar também as ações novas;
  - 7 lista de espera;
  - 8 relatórios.
- **Fechamento de cada onda:** Órion, Íris, versão e "pode publicar".
