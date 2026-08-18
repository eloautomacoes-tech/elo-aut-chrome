# Elo Aut — Plugin do WhatsApp Web

Extensão Chrome (Manifest V3) que injeta um painel lateral no `web.whatsapp.com` com os
dados do contato e o CRM da **Elo Automações**. Sem build, sem `node_modules`: carregar
sem compactação em `chrome://extensions` apontando para esta pasta.

Origem: clone do plugin **RD Elo** (`MVP-10/RD-elo/ChromePlugin`), que aponta para o app
Elo Odonto. Este aponta para o app Elo Automações.

## Backend

- `API_BASE` = `https://eloautomacoes.com.br` — definido em `src/background.js:11`.
  Precisa bater com `host_permissions` no `manifest.json`.
- Código-fonte do backend: `C:\dev\Elo-Automacoes` (Next.js, rotas em `src/app/api/`).

## Pendências no backend (rotas que o plugin chama e não existem no app Elo Automações)

Verificado comparando os 24 endpoints usados em `src/background.js` com
`C:\dev\Elo-Automacoes\src\app\api`. Faltam duas:

- **`/api/opportunities-list`** — chamada por `getOpportunities()` (mensagem
  `GET_OPPORTUNITIES`). Hoje falha. Existe uma implementação em
  `c:\dev\ELO-Lite\src\app\api\opportunities-list` que serve de base para portar.
- **`/api/auth/logout`** — chamada por `logout()`. O app só tem `auth/login` e
  `auth/refresh`. Degrada bem (o `catch` ignora a falha e limpa o `chrome.storage.local`),
  mas o refresh token não é invalidado no servidor.

As outras 22 existem: `whatsapp-lookup|pending|link|unlink|linked`, `branding`,
`auth/login`, `auth/refresh`, `agenda-today`, `followups-today`, `professionals`,
e os CRUDs `opportunity-*`, `scheduling-*`, `event-*`, `activity-*`.

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
