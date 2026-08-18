# Melhorias do Plugin "Elo Automações" — Especificação para Desenvolvimento

> Documento de handoff para o desenvolvedor. Consolida os pontos de melhoria solicitados e o que foi encontrado ao investigar o código atual do plugin (`ChromePlugin`) e do app principal (`Front-End`, Next.js). Nenhuma implementação foi feita ainda — isto é só a especificação.

## Contexto e descobertas importantes

O plugin é uma extensão Chrome MV3 **vanilla JS, sem framework e sem build step** (`src/content.js`, `src/background.js`, `src/popup.js`, `src/styles.css`, carregados diretamente pelo Chrome). O app principal ("RD Elo") é um projeto Next.js/React/Tailwind separado, em outro repositório (`Front-End`).

Duas descobertas mudam como os itens abaixo devem ser implementados em relação à spec original:

1. **A extensão já fala com o backend via REST API autenticada por Bearer token** (JWT access ~15min + refresh ~48h, gerenciados em `background.js`, guardados em `chrome.storage.local`) — **não** usa cookies nem `@supabase/ssr`. Esse padrão já existe e funciona (`/api/auth/login`, `/api/auth/refresh`, `/api/branding`, `/api/dashboard`, `/api/whatsapp-lookup` e afins).
2. **As Server Actions do Next.js (`createOpportunityAction`, `createSchedulingAction`, etc.) não podem ser chamadas diretamente pelo plugin** — elas dependem de sessão via cookies, que um content script cross-origin não consegue fornecer. É necessário criar **novas Route Handlers** (`app/api/.../route.ts`) autenticadas por Bearer token, reaproveitando a lógica de negócio das Server Actions (idealmente extraída para funções de serviço puras, para não duplicar código).
3. Componentes React do app principal (`ModalHeader.tsx`, `MaskedInput.tsx`, `RatingStars.tsx`, `Logo.tsx`) usam JSX/Tailwind e **não podem ser importados pela extensão**. Os padrões visuais devem ser portados manualmente para vanilla JS/CSS (o arquivo `elo-design-system.md`, na raiz deste repo, já documenta os tokens extraídos do app principal e deve ser a referência). Exceção: `src/lib/masks.ts` do app principal é lógica pura (sem React) e pode ser efetivamente portada como um módulo JS dentro do plugin.

---

## 1. Identidade visual — tema e logo da clínica

**Já implementado no backend, falta ajuste na extensão.** O endpoint `GET /api/branding` (Front-End) já retorna `{ title, logoUrl, theme: { accentColor, platformColor, mode, cssVars } }`, e `content.js` já consome isso via `applyBranding()` (linha ~957) aplicando variáveis CSS no painel.

- **Bug a corrigir**: o mapa de variáveis (`BRAND_VAR_MAP`, duplicado em `content.js` ~970-976 e `popup.js` ~90-96) não remapeia `--navy`/`--navy-2` (cor de plataforma do tenant) para as variáveis do painel (`--sf-navy`/`--sf-navy-2`) — hoje a cor "platformColor" configurada pelo tenant não aparece no cabeçalho/painel. Adicionar esse mapeamento nos dois lugares (idealmente extraindo a lógica duplicada para um módulo JS compartilhado entre `content.js` e `popup.js`).
- **Rename "WhatsApp Web" → "RD Elo"**: ocorre como rótulo de marca em exatamente 2 lugares — `content.js:118` (subtítulo padrão do cabeçalho, sobrescrito em runtime pelo `branding.title` quando carrega) e `popup.html:215`. As demais menções a "WhatsApp Web" no README, manifest e `popup.html:245` descrevem o produto real (o site WhatsApp Web) e **não devem mudar**.
- Gradiente navy do cabeçalho: já existe em `styles.css` via `--sf-navy`, `--sf-cyan`, `--sf-violet`, `--sf-grad` — reaproveitar esses tokens nos novos elementos (cabeçalho de oportunidade, modais).

## 2. Oportunidade sempre visível no topo

Cabeçalho persistente (sem precisar de scroll) com Nome, Status/Potencial, Telefone, Origem — visual de referência: hero navy de `/oportunidade/{id}` e o `OpportunityPanel.tsx` do app principal (avatar com iniciais, nome, badge de status, "Potencial X", origem com ícone).

- Implementar como um novo bloco fixo entre o cabeçalho atual (`#sf-wa-header`) e a área de dashboard/conteúdo — não como `sticky` dentro do scroll (evita complicação de z-index).
- **Dado faltando no backend**: o endpoint `/api/whatsapp-lookup` hoje devolve nome/telefone/potencial/status/link, mas **não devolve a origem** (`opportunity_source`) da oportunidade. Precisa ser adicionado à resposta (`src/lib/whatsapp/lookup.ts` no Front-End) para popular o campo "Origem" do cabeçalho.

## 3. Botões de ação / criação rápida

Em vez de manter 3 botões fixos separados ("Novo Agendamento" / "Novo Acompanhamento" / "Novo Histórico"), usar **um único controle dropdown** ("+ Novo") que abre as 3 opções — decisão para manter o cabeçalho enxuto, já que o painel também vai ganhar botão de reload, atalhos do dia e rail de ícones.

## 4. Atalhos "Agenda do Dia" e "Acompanhamentos do Dia"

Dois botões logo abaixo do cabeçalho de oportunidade.

- **Agenda do Dia**: lista os agendamentos do dia (`date = hoje`, escopado por `tenant_id` no servidor). Hoje **não existe** uma função pronta que devolva essa lista — `getAgendaData()` (`src/lib/scheduling/data.ts`) só devolve contadores. Precisa de uma nova função/rota (`getTodayAgenda` ou similar).
- **Acompanhamentos do Dia**: lista acompanhamentos com `due_date = hoje` e `status = PENDENTE`, escopado por `tenant_id`. Mesma situação — `getFollowUpsData()` (`src/lib/followups/data.ts`) só devolve contadores hoje. Precisa de nova função/rota.
- Clicar em qualquer item deve abrir uma visualização rápida do registro, com opção de editar — reaproveitando os endpoints de update e respeitando a matriz de permissões (ver seção 6).

## 5. Criação e edição das 4 entidades

Via novas Route Handlers autenticadas por Bearer token (não Server Actions diretas — ver descoberta #2 acima).

### Oportunidade
- Criar: equivalente a `createOpportunityAction`. Editar: equivalente a `updateOpportunityFieldAction`/`updateOpportunityAction`.
- Profissional tem acesso somente leitura, o Gestor tem acesso leitura, editar e criar, e o atendente acesso a leitura, editar e criar.
- Telefone/CPF/CEP sempre enviados sem máscara (`unmask`) para o backend.

### Agendamento
- Criar: equivalente a `createSchedulingAction`. Editar/cancelar: `updateSchedulingAction`/`cancelSchedulingAction`.
- Não permitir horário no passado; data mínima = hoje.
- Profissional só pode agendar para si mesmo, se Gestor, pode agendar para ele mesmo e outros profissionais do mesmo tenant_id, e quando atendente, pode selecionar o Gestor ou um profissionar no mesmo tenant_id. (`lockResponsible` — já implementado nas Server Actions, reaproveitar a mesma regra).
- Ao criar: subir potencial da oportunidade para `HIGH` e criar automaticamente um acompanhamento de confirmação (mesmo comportamento das Server Actions atuais).

### Histórico
- Criar: equivalente a `createEventAction`. Editar: `updateEventAction`.
- Eventos sistêmicos (tipo bate com `/autom[áa]tico|sist[eê]mico|sistema/i`) são somente leitura.
- A configuração `historyLog.notesManual` do tenant pode bloquear criação manual — respeitar esse gate.
- O histórico sempre estára ligado ao usuário que criar o registro

### Acompanhamento
- Criar: equivalente a `createActivityAction`. Editar/completar/cancelar: `updateActivityAction`/`completeActivityAction`/`cancelActivityAction`.
- Data >= hoje; horário opcional.
- Profissional só vê/edita os próprios acompanhamentos, Gestor Vê e editar ou cria para qualquer pessoa do mesmo tenant_id, e atendente Ve e Cria e editar para qualquer pessoa do mesmo tenant_id.

### ⚠️ Gap de permissão já existente no app principal (importante)
O `CLAUDE.md` do Front-End documenta que **hoje nenhuma Server Action valida no servidor** "Profissional = somente leitura em Oportunidade" nem "Profissional só edita os próprios Acompanhamentos" — isso só é escondido na UI (botões ocultos, campos não editáveis). Ao construir as novas rotas para o plugin, essas checagens de permissão devem ser implementadas corretamente no servidor (não só confiar na UI do plugin esconder botões) — idealmente numa camada de serviço compartilhada entre o app e o plugin, para fechar esse gap dos dois lados de uma vez em vez de ter a regra implementada de duas formas diferentes.

## 6. Autenticação e isolamento de tenant

- Reaproveitar o fluxo Bearer-token já existente (login/refresh já implementados em `background.js`).
- `tenant_id` e `role` **nunca** vêm do cliente — sempre derivados no servidor a partir do token verificado (`verifyAccessToken`) + lookup de `user_tenant.role`.
- Perfis: ADMIN, PROFISSIONAL, ATENDIMENTO ,GESTOR — matriz completa na seção "Planos, licenças e perfis (permissões)" do `CLAUDE.md` do Front-End.

## 7. Componentes/padrões reutilizáveis

Não é possível importar os componentes React diretamente (ver descoberta #3). Portar os **padrões visuais**, não o código:
- `ModalHeader.tsx` → cabeçalho navy com glow radial para os novos modais de criação/edição.
- `MaskedInput.tsx` / `src/lib/masks.ts` → portar as funções de máscara/unmask (telefone, CPF, CEP) como um módulo JS vanilla dentro do plugin (única peça que é lógica pura e pode ser efetivamente copiada, não só "inspirada").
- `RatingStars.tsx` → receita de preenchimento parcial de estrela via largura percentual (`clip`/`width`), útil se alguma tela do plugin mostrar avaliações.
- `Logo.tsx` → o plugin já tem uma função equivalente (`logoForContext()` em `content.js`) com fallback para a logo padrão — manter esse padrão.
- Referência central de tokens/design: `elo-design-system.md` (raiz deste repo).

## 8. Layout — aumentar a largura do painel

Hoje a largura é `320px` fixo, duplicado (hardcoded) em 3 lugares de `styles.css` (linhas 66, 79, 965) que precisam ficar manualmente em sync. Pedido: ~25% da largura da tela.

- Extrair para uma variável CSS única, ex. `--sf-panel-width: clamp(360px, 25vw, 620px)`, usada nos 3 lugares — evita ficar exageradamente largo em monitores grandes ou apertado em notebooks pequenos. (Não existe hoje nenhum padrão de "25% da tela" no app principal para replicar — é uma decisão nova só do plugin.)

## 9. Botão de recarregar

Atualiza **só os dados do CRM exibidos no painel** (dashboard, oportunidade atual, agenda do dia, acompanhamentos do dia) — refazendo as chamadas de leitura já existentes. Não deve dar reload na aba/página do WhatsApp Web (perderia a posição de scroll da conversa aberta).

## 10. Ícones de navegação rápida (rail lateral)

Uma coluna fina de ícones **dentro do próprio painel** (colada a uma borda interna, ex. lado esquerdo), sempre visível. Ao clicar em um ícone, rola (`scrollIntoView`) até a seção correspondente dentro do próprio painel (ex.: ícone de agenda → rola até a seção de agendamentos). Aplica-se a todas as seções relevantes (Oportunidade, Agenda, Acompanhamentos, Prontuário/Histórico). Cada seção precisa de um `id` para ser alvo do scroll.

## 11. Rename "Atividades" → "Prontuário"

A seção hoje rotulada "Últimas Atividades" no painel (`content.js:735`) na verdade exibe dados de **Histórico/Evento** (tabela `event`), não de Acompanhamento — é apenas um rótulo mal escolhido historicamente. Trocar para "Prontuário", consistente com o nome já usado no app principal (`OpportunityPanel.tsx` chama essa mesma seção de "Prontuário (histórico)"). **Não há mudança de dado**, só de texto.

---

## Notas de arquitetura para o desenvolvedor

- **CORS**: hoje nenhuma rota do Front-End tem CORS/`OPTIONS`. Na prática, como toda chamada do plugin sai do `background.js` (service worker com `host_permissions` para `http://localhost:3000/*`), CORS não bloqueia essas chamadas — mas vale adicionar um helper de CORS no backend mesmo assim, para facilitar testes diretos via `fetch` e documentar a superfície de API pensada para consumidores externos.
- **Backend**: para não duplicar 100% a lógica de negócio, o recomendado é extrair de cada Server Action uma função de serviço pura que recebe `{ tenantId, userId, role }` explicitamente (em vez de resolver via cookies), chamada tanto pela Server Action (que resolve o contexto via sessão) quanto pela nova Route Handler (que resolve o contexto via Bearer token) — evitando duas implementações da mesma regra de negócio.
- **Extensão**: manter a filosofia vanilla-JS sem build step — múltiplos arquivos `.js` podem ser listados no `manifest.json`/`popup.html` e compartilham escopo global, permitindo extrair módulos comuns (ex. máscaras, aplicação de tema) sem precisar de bundler.

## Ordem de implementação sugerida

1. Backend: helpers de autenticação (resolver tenant/role a partir do Bearer token) e CORS.
2. Backend: extrair a lógica de negócio das Server Actions para funções de serviço reutilizáveis, incluindo os gates de permissão do item 5.
3. Backend: novas consultas "de hoje" (agenda e acompanhamentos) e inclusão de `origem` no lookup.
4. Backend: novas Route Handlers para as 4 entidades (criar/editar) + as 2 listas "do dia".
5. Plugin: módulo de máscaras + correção do tema/navy (item 1).
6. Plugin: novos handlers de mensagem em `background.js` para os novos endpoints.
7. Plugin: ajustes visuais base (largura do painel, renames, tokens de gradiente).
8. Plugin: cabeçalho de oportunidade sticky (item 2).
9. Plugin: dropdown de criação + atalhos do dia + rail de ícones (itens 3, 4, 10).
10. Plugin: modais de criação/edição das 4 entidades (item 5, visual do item 7).
11. Plugin: botão de recarregar (item 9).

## Como testar

- Testar cada rota nova isoladamente (curl/Postman) com um token de teste antes de integrar ao plugin: casos sem token (401), sem permissão (403), payload inválido (400) e sucesso (200).
- Testar os gates de permissão com um usuário de teste `PROFISSIONAL`: confirmar que oportunidade fica somente-leitura e que só vê/edita os próprios agendamentos/acompanhamentos.
- Testar a extensão sem build: após qualquer mudança, recarregar em `chrome://extensions` e dar F5 na aba do WhatsApp Web (content scripts não recarregam sozinhos).
- Testar o tema: alternar `platformColor`/`mode` nas configurações do tenant de teste e confirmar que o navy do painel muda de acordo (valida a correção do item 1).
- Testar a largura do painel redimensionando a janela do navegador entre telas pequenas e grandes.
- Testar o botão de recarregar observando a aba Network do DevTools: não deve haver navegação de página, só as chamadas de API equivalentes.

### Painel com agendamentos e acompanhamento
- No painel superior deve ter agendamentos e acompanhamentos do dia
- cada profissional ou gestor tem estar informações 