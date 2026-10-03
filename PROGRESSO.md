# InnoChat — Progresso

Chatbot de agendamento via WhatsApp (n8n + Evolution API) com painel web multiempresa
para clínicas, salões e qualquer negócio de serviços com horário marcado.
Repositório: https://github.com/InnovareCodeDesenvolvimento/InnoChat (branch `main`; o antigo é o remote `antigo`).
Decisões do dono: memória `decisoes-iniciais-innochat` e `docs/arquitetura.md` §15.

## Atualização (2026-10-03): v1.7.5 no ar

**Publicado (v1.7.0 a v1.7.4):** pacote das 8 melhorias (monitor de erros próprio, backup cifrado no Drive, 2 etapas, auditoria 5 anos, Pixel + páginas por nicho, plano anual + cupons, lista de espera no bot, relatórios com comissões), fluxo do bot versionado (2.1.0, publicado), resposta automática do WhatsApp de cobrança corrigida, contato de cobrança fácil de corrigir, Configurações do Admin em abas com rota própria, recarga automática após publicação.

**Feito pelo dono:** 2 etapas ativada no Admin; fluxo 2.1.0 publicado; backup no Google Drive configurado, cifrado e conferido.

**Pendências do dono (configuração):** preço anual em Admin → Planos; Pixel do Meta (se for anunciar); planos ativos na landing; repetir suspensões manuais anteriores à v1.4.1; DMARC para quarantine entre 15 e 29/10. Resolvidos pelo dono em 2026-10-03: credenciais do Google login, credenciais de teste do Mercado Pago e troca da senha do banco de produção.

**Pendências da equipe:** nenhuma de código. Concluído na v1.7.5 (no ar em 2026-10-03 12h07): lista de espera a cada 5 min no próprio processo, Next 16.3.8 e nodemailer 10, baixos das revisões de segurança, testes independentes da hora e documentação com guia do dono. Restam só itens de configuração do dono acima. Risco residual aceito: 3 alertas do npm audit na cadeia do prisma (ferramenta de migração).

## Atualização (2026-10-02, fim do dia): v1.6.0 no ar

**Publicado:**
- **Financeiro no Admin** (v1.5.0): visão geral, Envios de cobrança (destinatário completo, texto enviado, reenvio seguro) e cobrança de cada empresa com linha do tempo.
- **Paginação numerada** (10/25/50/100).
- **Evidência do SMTP** em cada aviso e e-mail de teste no Admin (v1.5.1).
- **Monitor da cobrança** (v1.6.0): `/api/health/billing`, alertas no sino, card na Saúde e e-mail ao admin.

**Operação:**
- O dono criou o monitor no UptimeRobot e conectou o chip de cobrança.
- Domínio de e-mail com SPF, DKIM (`titan1`) e DMARC `p=none`.
- O push usa a conta fixa InnovareCodeDesenvolvimento, sem prompt.

**Próximo:**
- F8: documentação da régua (Alexandria).
- Avaliar DMARC `p=quarantine` em 2 a 4 semanas.

## Atualização (2026-10-02): v1.4.1 no ar

**Publicado desde a v1.1.1:**
- Landing premium:
  - celular realista com o Inno;
  - "Você conhece esse dia" multi-nicho;
  - rede animada, painel 3D e jornada em rolagem;
  - botão "Tirar dúvidas" com o WhatsApp comercial cadastrado no Admin.
- Cancelamento e reativação pelo painel (Termos de 2026-10-01).
- Textos humanizados em todo o sistema (`docs/guia-de-voz.md`).
- Régua de cobrança completa (`docs/regua-de-cobranca.md`):
  - outbox `BillingNotice`;
  - carência de 3 dias;
  - sequência do teste grátis com dados reais;
  - WhatsApp de cobrança da plataforma, trocável no Admin;
  - avisos no painel;
  - contato de cobrança com confirmação por SIM.

**Pendências do dono:**
- Conectar o chip de cobrança em Admin → Configurações.
- Repetir no Admin as suspensões manuais anteriores à v1.4.1.
- Credenciais do Google.
- Ativar os planos que devem aparecer na landing.

**Próximas fases da régua:**
- F6, visão financeira no Admin (MRR, inadimplência, timeline);
- F7, health/monitor externo;
- F8, documentação.

## Atualização (2026-09-30)

**No ar:**
- Login com Google. As credenciais ainda não foram cadastradas pelo dono em Admin → Configurações.
- Bot v2, fluxo 2.0.0 publicado:
  - menu revisado;
  - limite de 3 agendamentos futuros por cliente;
  - horários de 15 ou 30 minutos;
  - pedido de atendente com pausa, aviso à equipe e retomada;
  - confirmação e "Posso ajudar em algo mais?" em 2 mensagens.
- Atendimento humano:
  - página **Atendimento**, estilo WhatsApp Web: fila, resposta e botão "encerrar e devolver ao bot";
  - aviso ao cliente no WhatsApp quando a equipe agenda, remarca ou cancela, com switch e textos editáveis;
  - aviso "o cliente receberá..." nos formulários;
  - pausa única (`handoffResumeMinutes`) para resposta pelo painel ou pelo celular, só no fluxo v2.
- Endurecimento pós-Órion:
  - envio idempotente;
  - teto de 10 mensagens por hora por contato e 120 por hora por empresa.

**Validado pelo dono:** aviso ao cliente na agenda.

**Publicado também:**
- ajuda ⓘ com exemplos em todas as telas (44 entradas);
- favicon;
- selo flutuante compacto que sai do caminho dos botões;
- versionamento semântico com CHANGELOG. **No ar: v1.1.1.**

**Ideia registrada:** campanha no Meta Ads. Funil em 3 etapas mais anúncio de mensagem com número de demonstração do bot. Antes, precisa de pixel/CAPI, landing page por nicho e dados da empresa para os termos. O dono decide nicho, orçamento e oferta.

**Débitos:**
- trava de publicação do fluxo, teto de envios e cache de idempotência ficam só em memória (processo único);
- cooldown do TECH_ERROR;
- rotacionar a senha do banco de produção;
- o sandbox do Mercado Pago está com credenciais live;
- o E2E "Sino do admin" (fase2-ui) está falhando e há uma tarefa separada investigando.

## Estado atual (2026-09-29)

**No ar em produção** em `https://innochat.innovarecode.com.br` (Easypanel, projeto `pontua-me`, auto-deploy por
push; migrations rodam sozinhas no boot do container). Versão exibida: **v1.0.0**.

Validado de ponta a ponta pelo dono em produção:
- **WhatsApp:** QR → "oi" → agendar, remarcar e cancelar pelo bot.
- **Pix:** Pix real gerado → pago → reconhecido e baixado pela conciliação ativa.

## Concluído

- **Painel da empresa:**
  - Início (indicadores, gráfico, Próximos atendimentos hoje);
  - Agenda dia/semana com arrastar para remarcar;
  - Agendamentos com status, origem e linha do tempo;
  - Clientes, Serviços, Profissionais;
  - WhatsApp (celular no estilo WhatsApp, QR ao vivo);
  - Mensagens do bot;
  - Configurações (3 temas, bloqueios, equipe);
  - Assinatura (Pix com conferência automática);
  - onboarding com o mascote **Inno** (tour + checklist).
- **Experiência:**
  - central de notificações (sino, toasts, título da aba);
  - atualização ao vivo sem F5;
  - barra de navegação + skeletons + loader padrão;
  - ícone do menu no título de cada página;
  - selo InnovareCode + versão;
  - login/cadastro premium com o Inno;
  - e-mails transacionais premium + recibo de pagamento.
- **Admin da plataforma:**
  - Configurações: Evolution, n8n (sync deriva a URL do webhook do nó e reaponta instâncias), SMTP, Mercado Pago com produção + sandbox e segredos cifrados AES-256-GCM;
  - Planos, Empresas;
  - Cobrança (card "Em teste", conferir no MP);
  - Saúde (diagnóstico do webhook do MP);
  - Dados jurídicos.
- **Cobrança:**
  - teste de 3 dias;
  - teste não convertido: suspenso em 1 dia, cancelado em +7 dias, fatura anulada;
  - conciliação ativa do Pix (tela, tick, admin);
  - baixa só com referência e valor exatos.
- **Qualidade:** ~360 unitários, ~220 de integração, 125 E2E contra build de produção; revisões do Órion aprovadas.

## Etapa D — CONCLUÍDA (2026-09-29)

Validado pelo dono em produção: bot WhatsApp, Pix real baixado, e-mail real entregue, webhook do MP simulado = 200.
Único acompanhamento: primeira execução do `maintenance/tick` (03:15) em Admin → Saúde.

## Recomendações ao dono

- **Trocar a senha do banco de produção:** ela apareceu em logs colados no chat e é igual à local.
- **`AUTH_SECRET` é definitivo:** agora ele cifra os segredos salvos. Trocar exige recadastrar Evolution, n8n, SMTP e MP.
- **Card sandbox do MP:** tem credenciais de produção (o MP recusa com "live credentials"). Colocar as de teste ou usar só Produção.

## Pós-v1 / ideias

- Ação "concluir / cliente faltou" no agendamento (as notificações desses casos já existem).
- Sino no admin da plataforma.
- Conversa do mockup do WhatsApp com a mensagem real de boas-vindas.
- Lembrete de véspera ao cliente.
- Histórico de conversas.
- Rate limit distribuído.

## Decisões em aberto (dono)

- Texto próprio "Confirma a remarcação?"?
- Card "Adicionar número" escondido quando o plano está no limite?
