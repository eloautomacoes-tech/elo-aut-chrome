# Elo Aut — Plugin do WhatsApp Web

Extensão Chrome (Manifest V3) que injeta um painel lateral no `web.whatsapp.com` com os
dados do contato e o CRM da **Elo Automações**. Sem build, sem `node_modules`: carregar
sem compactação em `chrome://extensions` apontando para esta pasta.

Origem: clone do plugin **RD Elo** (`MVP-10/RD-elo/ChromePlugin`), que aponta para o app
Elo Odonto. Este aponta para o app Elo Automações.

## Backend

- Dois ambientes, definidos no topo do `src/background.js`:
  `PROD_API_BASE` = `https://eloautomacoes.com.br` (padrão) e
  `DEV_API_BASE` = `http://localhost:3001` (o `docker compose up dev` do app,
  que mapeia `3001:3000`). Ambos precisam estar em `host_permissions`.
- A troca é feita no **popup da extensão** (rodapé "Ambiente"), fica guardada em
  `chrome.storage.local.apiBase` e **derruba a sessão** — token emitido num
  ambiente não vale no outro, então é preciso entrar de novo depois de trocar.
- Código-fonte do backend: `C:\dev\Elo-Automacoes` (Next.js, rotas em `src/app/api/`).
- Rota nova no backend precisa entrar em `PUBLIC_ROUTES` de `src/proxy.ts` — sem
  isso o proxy redireciona `/api/...` para `/login` (307) antes de a rota rodar,
  e a extensão recebe HTML em vez do 401/JSON.

## Rotas do backend usadas pelo plugin

Os 27 endpoints chamados em `src/background.js` existem em
`C:\dev\Elo-Automacoes\src\app\api`. `opportunities-list` e `auth/logout`,
que faltavam, já foram implementados lá.

⚠️ **Três rotas são novas e ainda não foram para produção.** Enquanto o deploy em
`eloautomacoes.com.br` não sai, dá para testar apontando o popup para `Local :3001`;
em produção, o botão "Ver lead" mostra "Erro ao carregar a ficha do lead":

- **`GET /api/whatsapp-lead?id=`** (`GET_LEAD_DETAIL`) — ficha do lead pelo id da
  oportunidade: momento do funil, contato, origem, responsável e próxima ação.
  Lib: `src/lib/whatsapp/lead.ts`. Serve os dois `kind` da tabela `opportunity`
  (PROSPECCAO = cadência de toques, OPORTUNIDADE = funil comercial).
- **`GET /api/campanhas-list`** (`GET_CAMPAIGNS`) — campanhas **ativas** do tenant
  com `messageText`/`link`/`mediaUrl`, para o seletor "Campanha" da ficha do lead.
- **`POST /api/whatsapp-send`** (`REGISTER_WHATSAPP_SEND`) — efeitos do botão
  "Enviar no WhatsApp" da ficha: avança o funil uma etapa, põe o lead no nome de
  quem enviou e vincula a conversa aberta (`name_whatsapp_opportunity`).
  Lib: `src/lib/whatsapp/send.ts`. O clique registra o toque e fecha o modal
  **mesmo que a conversa não abra** (o funil não fica refém do DOM do WhatsApp);
  só o vínculo exige conversa aberta e confirmada, senão a oportunidade grudaria
  na conversa errada.

## Diferenças em relação ao RD Elo (manter ao portar mudanças entre os dois)

- `manifest.json`: `"name": "Elo Aut"`, versão iniciada em 1.0.0.
- Domínio: `eloautomacoes.com.br` (o RD Elo usa `odonto.eloautomacoes.com.br`) —
  aparece em `manifest.json`, `src/background.js`, `popup.html`, `src/content.js`.
- Política de privacidade: `/politica-de-privacidade`. A rota
  `/termos-privacidade-plugin` que o RD Elo usa só existe no app Elo Odonto.
- `assets/rd-elo-logo*.png` foram removidos (não eram referenciados por nenhum arquivo).

## Estrutura

```
manifest.json          # MV3
popup.html             # tela de login (ícone da extensão)
src/popup.js           # lógica do popup
src/background.js      # service worker — único lugar que guarda os tokens e fala com a API
src/content.js         # painel lateral injetado no WhatsApp Web (arquivo grande, ~114 KB)
src/branding-shared.js # mapa das CSS vars de marca; compartilhado por content.js e popup.js
src/masks.js           # máscaras de input
src/styles.css         # estilos do painel (Design System Elo — ver elo-design-system.md)
assets/                # logos de fallback; a logo real vem do tenant via GET /api/branding
icons/                 # ícones da toolbar (gerados por create-icons.js)
```

## Notas de arquitetura

- `content.js` e `popup.js` **nunca** veem os tokens — só trocam mensagens com
  `background.js`, que guarda `accessToken`/`refreshToken` no `chrome.storage.local` e
  renova o access token antes de cada chamada (`getValidToken()`).
- Cores e logo vêm do tenant em runtime via `GET /api/branding`; `background.js` baixa a
  logo e converte para data URL, porque o CSP do WhatsApp Web bloqueia imagens externas
  no content script.
- Depois de alterar o código: recarregar a extensão em `chrome://extensions` **e**
  recarregar a aba do `web.whatsapp.com` (para mudanças em `content.js`/`styles.css`).

## Validação rápida (não há testes automatizados)

```bash
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"
for f in src/*.js create-icons.js; do node --check "$f"; done
```
