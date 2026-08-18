# Elo Aut — Painel de Contato para WhatsApp Web

Extensão para Chrome (Manifest V3) que injeta um painel lateral no [WhatsApp Web](https://web.whatsapp.com)
com os dados do contato/conversa aberta, integrado ao CRM da **Elo Automações**.

## Funcionalidades

- Painel lateral fixo no WhatsApp Web com dados do contato (nome, telefone, foto, bio, categoria de negócio).
- Suporte a grupos (descrição e participantes).
- Login embutido no próprio painel — autentica contra o backend da Elo Automações.
- Dashboard com estatísticas (agendamentos do dia, pendentes, da semana, atendimentos da semana).
- Busca automática da oportunidade/contato no CRM ao abrir uma conversa.
- Vincular/desvincular conversa do WhatsApp a uma oportunidade pendente do CRM.
- Lista de contatos já vinculados, com opção de desvincular.
- Histórico de últimas atividades e agendamentos por contato.

## Pré-requisitos

- Google Chrome (ou outro navegador baseado em Chromium: Edge, Brave, etc).
- Backend da Elo Automações acessível (por padrão a extensão aponta para `https://eloautomacoes.com.br` —
  ver `src/background.js`, constante `API_BASE`).

## Instalação (modo desenvolvedor, sem compactação)

Esta extensão ainda não está publicada na Chrome Web Store. Para instalar localmente, sem gerar
nenhum `.zip`/`.crx`, use o modo "Carregar sem compactação":

1. Baixe ou clone este repositório:
   ```bash
   git clone <url-do-repositorio>
   ```
2. Abra o Chrome e acesse `chrome://extensions`.
3. No canto superior direito, ative o **Modo do desenvolvedor**.
4. Clique em **Carregar sem compactação** ("Load unpacked").
5. Selecione a pasta raiz do projeto (a que contém o arquivo `manifest.json`).
6. A extensão "Elo Aut" vai aparecer na lista e na barra de ferramentas do Chrome.

Pronto — nenhum passo de build ou empacotamento é necessário.

### Atualizando depois de alterar o código

Sempre que alterar arquivos da extensão, volte em `chrome://extensions` e clique no ícone de
**recarregar** (↻) no card da extensão. Para mudanças em `content.js`/`styles.css`, também é
preciso recarregar a aba do `web.whatsapp.com` aberta.

## Como usar

1. Clique no ícone da extensão na barra do Chrome e faça login com seu usuário da Elo Automações.
2. Abra o `web.whatsapp.com`.
3. Clique em qualquer contato ou conversa.
4. Os dados aparecem automaticamente no painel lateral à direita.

## Estrutura do projeto

```
manifest.json        # configuração da extensão (MV3)
popup.html           # tela de login (ícone da extensão)
src/popup.js         # lógica do popup de login
src/background.js    # service worker — guarda o token e fala com a API
src/content.js       # injeta e controla o painel lateral no WhatsApp Web
src/styles.css        # estilos do painel lateral (Design System Elo)
assets/              # logos da Elo Automações
icons/               # ícones da extensão (toolbar)
```
