# Fase 1 — Scraping de Contato no WhatsApp Web

## Objetivo
Painel lateral injetado em `web.whatsapp.com` que lê os dados do contato/conversa aberta e exibe (nome, telefone, foto, bio, categoria business, grupo).

## Onde está
- `manifest.json` — content script registrado só para `https://web.whatsapp.com/*`
- `src/content.js` — toda a lógica de scraping + render do painel
- `src/styles.css` — layout lado a lado (sidebar fixa 320px à direita, `#app` forçado a `right: 320px`)

## Padrão para pegar o nome na tela (ordem de fallback)
Confirmado contra DOM real salvo (`docs/(59) WhatsApp Business.html`, contato "Edu"). Estratégia em camadas — a mais específica/estável primeiro, cai para estrutura pura se o testid girar:
1. **Âncora verificada:** `#main header span[data-testid="conversation-info-header-chat-title"]` → texto = nome. Foi o seletor que realmente casou no HTML capturado.
2. **Fallback estrutural:** primeiro `span` de texto folha (sem `span` filho) dentro do `<header>` do `#main`. O botão da foto de perfil tem só `<img>` (sem texto) e `title="Dados do perfil"` — não polui essa busca.
3. Desambiguação `looksLikeStatus` continua para não pegar linha de status no lugar do nome.

## Por que seletores estruturais + testid verificado, não `data-testid` chutado
WhatsApp Web ofusca/roda nomes de classe a cada release. `data-testid` **chutado** sem testar contra a página real deu errado (nada aparecia). Diferença agora: o testid acima foi **extraído do DOM real**, não inventado — por isso vira âncora primária, mas sempre com o fallback estrutural abaixo caso ele mude:
- Header do chat é sempre uma tag `<header>` real dentro de `#main` (`data-testid="conversation-header"` no capture)
- Nome do contato = primeiro `span` de texto folha (sem `span` filho) dentro do header
- Segundo span de texto = candidato a status — usado **só internamente** pra não confundir com nome (status em si não é mais exibido, ver decisão abaixo)
- `title=""` é adicionado pelo WhatsApp em **qualquer** span truncado por elipse (não é exclusivo do nome) — por isso não pode ser o critério principal de seleção, só um fallback pra pegar o texto completo não-truncado
- Telefone: contato não salvo → nome já é o número; contato salvo → procura `span[dir="ltr"]` no painel de info (WhatsApp força LTR em números)
- Campos tipo "Sobre"/"Categoria da empresa" → busca por texto de rótulo exato + valor no elemento irmão seguinte (padrão "label depois valor" dos painéis do WhatsApp)

## Decisões tomadas
- **Status (online/visto por último) removido** — usuário só precisa do nome. Lógica de desambiguação (`looksLikeStatus`) continua existindo internamente pra garantir que o nome certo seja escolhido, mas o campo não é mais coletado nem renderizado.
- **Layout lado a lado, não overlay** — WhatsApp ancora o container raiz (`#app`/`#startup`) fixo no viewport (resistente a flexbox comum). Fix: forçar `#app`/`#startup` com `position: fixed !important; right: 320px !important` quando a sidebar está aberta.
- **Detecção de grupo** hoje depende só de achar "Descrição do grupo" no painel de info aberto — não há fallback puramente pelo header (campo de status, que indicava "X participantes", foi removido). Lista de membros do grupo não é capturada de forma confiável ainda (não testado contra DOM real).

## Limitações conhecidas / não testado contra DOM real
- Não tenho navegador pra abrir o WhatsApp Web logado durante o desenvolvimento — seletores foram ajustados a partir de prints/feedback do usuário, não de inspeção direta.
- Sem teste de logger de debug (`console.log('[WA-PANEL] ...')` em `content.js`) ainda usado pra calibrar quando nome não é encontrado.
- Lista de participantes de grupo: função removida na primeira reescrita por ser baseada em seletor inventado; não foi reimplementada.

## Próximo nível de robustez (não implementado, considerar se DOM mudar de novo)
Extensões de CRM para WhatsApp "de verdade" (Kommo, Zenvia etc.) não fazem scraping de DOM — eles leem o `Store` interno do WhatsApp Web via injeção de script no `MAIN world` (técnica usada por `whatsapp-web.js`/`wa-js`). É mais robusto (sobrevive a mudança de classe/testid) mas mais complexo de manter e mais invasivo. Não vale o esforço agora; só considerar se o DOM scraping voltar a quebrar com frequência.
