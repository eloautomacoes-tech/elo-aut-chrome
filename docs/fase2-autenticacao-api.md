# Fase 2 — Autenticação e Integração com API (NextJS)

## Objetivo
Extensão autentica com email/senha numa API NextJS existente, recebe token, usa token pra buscar dados do contato (pelo nome capturado na Fase 1) armazenados no sistema do usuário. Telefone não é confiável o suficiente no scraping pra ser usado como chave de busca.

Este arquivo é orientação de arquitetura/segurança pra implementar no **outro projeto** (a API NextJS) e na extensão. Nenhum código NextJS foi implementado aqui.

## Arquitetura recomendada na extensão

### Separação de responsabilidades
- **`background.js`** (service worker, Manifest V3): único lugar que guarda o token e faz `fetch` pra API. Login, expiração, logout — tudo centralizado aqui.
- **`content.js`**: só scraping + UI (já existe, Fase 1). Pra buscar dado no sistema, manda `chrome.runtime.sendMessage({ type: 'LOOKUP_CONTACT', phone })` pro background e espera resposta. Nunca guarda nem manipula token direto.
- **Tela de login** (popup ou aba própria): só pede email/senha e manda pro background via mensagem. Senha não é guardada em lugar nenhum depois do POST.

**Por quê separar assim:** o `content.js` roda dentro do contexto da página `web.whatsapp.com`. Mesmo isolado (isolated world), é mais superfície de exposição que o `background.js`, que roda fora do contexto de qualquer página web. Token fica isolado em 1 único lugar.

### Fluxo de login
1. Tela de login pede email/senha.
2. `POST <API_BASE>/api/auth/login` com `{ email, password }`. Em produção sempre HTTPS — por enquanto, em dev, `http://localhost:3000` (sem HTTPS, só pra teste local; trocar antes de ir pra produção).
3. API valida, retorna `{ token, expiresAt }` (JWT).
4. `background.js` salva o token em `chrome.storage.local`.
5. Senha usada só no momento do POST, nunca persistida em disco/storage.

### Onde guardar o token
- **`chrome.storage.local`** — storage isolado por extensão, não acessível por páginas web nem outras extensões. É a escolha certa aqui.
- **Nunca** usar `localStorage`/`sessionStorage` a partir do content script — isso pertenceria ao domínio `web.whatsapp.com`, não é isolado, fica exposto a qualquer script que rode na página.
- Se quiser que o token expire ao fechar o navegador (mais restritivo): `chrome.storage.session` (MV3, em memória).
- `chrome.storage.local` não é criptografado em disco por padrão — nível equivalente a um cookie de sessão comum. Suficiente pra maioria dos casos; não tratar como cofre. Token de vida curta reduz risco mais que criptografia client-side.

### Requisições autenticadas
- Toda chamada subsequente leva header `Authorization: Bearer <token>`.
- Em resposta `401` → limpa token do storage, força novo login.
- Endpoint implementado: `GET /api/contacts/lookup?name=<nome do contato>` — telefone não está disponível de forma confiável no scraping (Fase 1), então a busca é por nome. Ciente de que nome no WhatsApp varia (apelido, acento, abreviação) — o match no backend precisa ser tolerante (case-insensitive, talvez parcial) em vez de igualdade exata.

## Checklist de segurança pro lado da API (NextJS)

1. **Hash de senha**: bcrypt ou argon2, nunca texto puro.
2. **Erro genérico no login**: nunca diferenciar "email não existe" de "senha errada" na resposta — sempre "credenciais inválidas". Evita enumeração de usuários.
3. **Rate limit no `/api/auth/login`**: ex. 5 tentativas / 15 min por IP. Sem isso dá pra forçar senha por brute-force.
4. **JWT de vida curta**: 1h é razoável. Sem refresh token por enquanto — simplicidade. Expira, usuário loga de novo. Se precisar sessão mais longa sem repetir login toda hora, refresh token é o passo natural seguinte, mas não é necessário pra um MVP.
5. **CORS restrito**: origem de extensão Chrome é `chrome-extension://<ID_DA_EXTENSAO>`. Configurar CORS da API pra aceitar só essa origem, nunca `*`.
6. **HTTPS obrigatório** em toda rota (Vercel já força isso por padrão).
7. **Validar token em toda rota protegida** via middleware — verificar assinatura e expiração, não confiar que "se mandou token, é válido".
8. **Nunca retornar a senha** (nem hash) em nenhuma resposta da API, inclusive em endpoints de perfil/usuário.

## Sobre "segredos" na extensão
Código de extensão Chrome é 100% inspecionável por quem instala — JS legível, sem build step que esconda nada. Isso não é problema aqui porque não há segredo embutido: o usuário usa a própria senha, a API não precisa de uma API key fixa dentro do código da extensão. Cuidado real: nunca colocar uma chave "mestra" fixa em `content.js`/`background.js` pensando que está escondida — não está, qualquer um que instale a extensão lê o arquivo.

## Implementado no lado da extensão
- `manifest.json`: `host_permissions` com o domínio da API + `background.service_worker`
- `src/background.js`: handlers de mensagem `LOGIN`, `LOGOUT`, `GET_AUTH_STATE`, `LOOKUP_CONTACT` — único lugar com acesso ao token
- `popup.html` + `src/popup.js`: tela de login (email/senha) quando não autenticado; tela de status + logout quando autenticado
- `src/content.js`: ao identificar contato (nome já extraído na Fase 1), manda `{ type: 'LOOKUP_CONTACT', name }` pro background via `chrome.runtime.sendMessage`, recebe dados do sistema, renderiza na seção "Sistema" do painel

## Falta no lado da API (NextJS — outro projeto)
- `POST /api/auth/login` retornando `{ token, expiresAt }`
- `GET /api/contacts/lookup?name=...` autenticado via `Authorization: Bearer`, retornando `{ ...dados }` (200), 404 se não achar, 401 se token inválido/expirado
- Checklist de segurança da seção acima (hash de senha, rate limit, CORS, etc.)
