/**
 * CRM para WhatsApp Web - Content Script
 * Scrapes contact data from WhatsApp Web and displays in sidebar
 */

(function () {
  'use strict';

  // ─── Config ───────────────────────────────────────────────────────────────

  const REFRESH_INTERVAL_MS = 1500; // poll interval when chat is open
  const PLUGIN_ID = 'sf-wa-sidebar';

  // Structural selectors — based on stable HTML semantics (tag names, title/dir
  // attributes) instead of WhatsApp's obfuscated/rotating class names or
  // unverified data-testid guesses.
  const SEL = {
    mainHeader:         '#main header',
    // Verified against a real saved DOM (docs capture): the open-chat name is
    // in a span WhatsApp tags with this testid. Used as the primary anchor;
    // the structural "first leaf span" logic below is the fallback if it rotates.
    chatTitleSpan:      'span[data-testid="conversation-info-header-chat-title"]',
    selectedChatTitle:  '#pane-side [aria-selected="true"] span[title]',
    selectedChatImg:    '#pane-side [aria-selected="true"] img',
  };

  // ─── State ────────────────────────────────────────────────────────────────

  let sidebar = null;
  let collapseTab = null;
  let isOpen = true;
  let currentContact = {};
  let currentBranding = null;
  let pollTimer = null;
  let lastChatTitle = '';
  let isLinkedView = false;
  let isNewMenuOpen = false;
  let currentUserRole = null;
  let currentUserId = null;
  let appBase = null; // URL base do CRM (ex.: link "Gerenciar pagamento") — vem do GET_AUTH_STATE
  let currentOpportunity = null; // { id, name } — oportunidade vinculada ao contato atual
  let lastAgendaResult = null; // cache da última resposta de GET_AGENDA_TODAY, pra re-filtrar sem esperar o próximo poll
  let lastAgendaRendered = []; // itens da agenda efetivamente renderizados (já filtrados) — usados no clique
  let lastFollowUpsResult = null; // idem pra GET_FOLLOWUPS_TODAY
  let lastTimelineItems = []; // atividades + agendamentos mesclados na timeline única — clique por índice
  let flashTimer = null; // timeout que esconde a faixa de confirmação (ver showFlash)

  // ─── Bootstrap ────────────────────────────────────────────────────────────

  // Assinatura do painel. O plugin RD Elo (clone deste, apontando para o app
  // Elo Odonto) usa o MESMO id de elemento: com os dois instalados só um
  // renderiza — quem ganhar a corrida no carregamento da aba —, e o painel do
  // outro app é visualmente idêntico. O sintoma aparece só nos links ("Abrir
  // paciente" leva para o domínio dele). Daí o aviso no console.
  const PANEL_BUILD = 'elo-aut';

  function init() {
    const existing = document.getElementById(PLUGIN_ID);
    if (existing) {
      if (existing.getAttribute('data-sf-build') !== PANEL_BUILD) {
        console.warn(
          '[WA-PANEL] Elo Aut não injetou: esta aba já tem o painel de outra extensão (%s). ' +
          'Desative a outra em chrome://extensions e recarregue a aba.',
          existing.getAttribute('data-sf-build') || 'RD Elo / versão antiga',
        );
      }
      return;
    }
    injectSidebar();
    checkAuth();
  }

  // Gate de acesso: scraping só roda depois de autenticado.
  function checkAuth() {
    chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' }, (state) => {
      if (state && state.authenticated) {
        currentUserRole = state.role || null;
        currentUserId = state.userId || null;
        appBase = state.appBase || null;
        onAuthenticated();
      } else {
        renderLoginView();
      }
    });
  }

  function onAuthenticated() {
    sidebar.querySelector('#sf-wa-logout-btn').classList.remove('sf-hidden-el');
    sidebar.querySelector('#sf-wa-home-btn').classList.remove('sf-hidden-el');
    sidebar.querySelector('#sf-wa-refresh-btn').classList.remove('sf-hidden-el');
    sidebar.querySelector('#sf-wa-linked-toggle-btn').classList.remove('sf-hidden-el');
    sidebar.querySelector('#sf-wa-new-btn').classList.remove('sf-hidden-el');
    sidebar.querySelector('#sf-wa-day-shortcuts').classList.remove('sf-hidden-el');
    sidebar.querySelector('#sf-wa-rail').classList.remove('sf-hidden-el');
    updateNewMenuAvailability();
    renderEmpty();
    startPolling();
    fetchAgendaToday();
    fetchFollowUpsToday();
    observeChatChanges();
    chrome.runtime.sendMessage({ type: 'GET_BRANDING' }, (res) => {
      applyBranding(res && res.branding);
    });
  }

  // WhatsApp loads dynamically; wait for app shell
  function waitForApp() {
    const check = setInterval(() => {
      if (document.querySelector('#app') || document.querySelector('#startup')) {
        clearInterval(check);
        init();
      }
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForApp);
  } else {
    waitForApp();
  }

  // ─── Sidebar HTML ─────────────────────────────────────────────────────────

  function injectSidebar() {
    // Collapse tab (always visible toggle)
    collapseTab = document.createElement('button');
    collapseTab.id = 'sf-wa-collapse-tab';
    collapseTab.title = 'Dados do contato';
    collapseTab.innerHTML = chevronRightSVG();
    collapseTab.addEventListener('click', toggleSidebar);
    document.body.appendChild(collapseTab);

    // Main sidebar
    sidebar = document.createElement('div');
    sidebar.id = PLUGIN_ID;
    sidebar.setAttribute('data-sf-build', PANEL_BUILD);
    sidebar.innerHTML = buildSidebarHTML();
    document.body.appendChild(sidebar);

    document.body.classList.add('sf-sidebar-open');

    // Wire events
    sidebar.querySelector('#sf-wa-toggle-btn').addEventListener('click', toggleSidebar);
    sidebar.querySelector('#sf-wa-logout-btn').addEventListener('click', handleLogout);
    sidebar.querySelector('#sf-wa-linked-toggle-btn').addEventListener('click', toggleLinkedView);
    sidebar.querySelector('#sf-wa-refresh-btn').addEventListener('click', handleManualRefresh);
    sidebar.querySelector('#sf-wa-home-btn').addEventListener('click', handleGoHome);

    // Dropdown "+ Novo"
    sidebar.querySelector('#sf-wa-new-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCreateDropdown();
    });
    sidebar.querySelectorAll('.sf-new-menu-item').forEach(btn => {
      btn.addEventListener('click', () => openCreateModal(btn.getAttribute('data-kind')));
    });
    document.addEventListener('click', (e) => {
      if (isNewMenuOpen && !sidebar.querySelector('.sf-new-dropdown').contains(e.target)) {
        closeCreateDropdown();
      }
    });

    // Atalhos "do dia"
    sidebar.querySelector('#sf-wa-agenda-today-btn').addEventListener('click', toggleAgendaToday);
    sidebar.querySelector('#sf-wa-followups-today-btn').addEventListener('click', toggleFollowUpsToday);
    sidebar.querySelector('#sf-wa-agenda-today').addEventListener('click', handleAgendaItemClick);
    sidebar.querySelector('#sf-wa-followups-today').addEventListener('click', handleFollowUpItemClick);

    // Listas do CRM (Últimas Atividades / Últimos Agendamentos) — clique delegado
    // no sidebar, já que #sf-wa-crm-content é (re)criado a cada lookup.
    sidebar.addEventListener('click', handleCrmListClick);

    // Rail de ícones
    sidebar.querySelectorAll('.sf-rail-btn').forEach(btn => {
      btn.addEventListener('click', () => handleRailClick(btn));
    });
  }

  function buildSidebarHTML() {
    return `
      <div id="sf-wa-header">
        <div class="sf-logo-area">
          <img class="sf-logo" src="${logoForContext('logo-sem-fundo2.png')}" alt="Elo Automações" />
        </div>
        <div class="sf-header-actions">
          <div class="sf-new-dropdown">
            <button id="sf-wa-new-btn" class="sf-hidden-el" title="Criar novo">${plusSVG()} Novo</button>
            <div id="sf-wa-new-menu" class="sf-new-menu sf-hidden-el">
              <button type="button" class="sf-new-menu-item" data-kind="scheduling">Novo Agendamento</button>
              <button type="button" class="sf-new-menu-item" data-kind="activity">Novo Acompanhamento</button>
              <button type="button" class="sf-new-menu-item" data-kind="event">Nova Atividade</button>
              <div class="sf-new-menu-sep"></div>
              <button type="button" class="sf-new-menu-item" id="sf-wa-new-opportunity-item" data-kind="opportunity">+ Nova Oportunidade</button>
            </div>
          </div>
          <button id="sf-wa-home-btn" class="sf-hidden-el" title="Voltar ao início">${homeSVG()}</button>
          <button id="sf-wa-refresh-btn" class="sf-hidden-el" title="Atualizar agora">${refreshSVG()}</button>
          <button id="sf-wa-linked-toggle-btn" class="sf-hidden-el" title="Contatos vinculados">${linkedListSVG()}</button>
          <button id="sf-wa-logout-btn" class="sf-hidden-el" title="Sair">${logoutSVG()}</button>
          <button id="sf-wa-toggle-btn" title="Minimizar">${closeSVG()}</button>
        </div>
      </div>
      <div id="sf-wa-flash" class="sf-hidden-el"></div>
      <div id="sf-wa-opportunity-bar" class="sf-hidden-el"></div>
      <div id="sf-wa-day-shortcuts" class="sf-hidden-el">
        <div class="sf-day-shortcut-row">
          <button type="button" id="sf-wa-agenda-today-btn" class="sf-day-shortcut-btn">${calendarSVG()} Agenda do Dia <span id="sf-wa-agenda-today-count" class="sf-day-shortcut-count sf-hidden-el"></span></button>
          <button type="button" id="sf-wa-followups-today-btn" class="sf-day-shortcut-btn">${checklistSVG()} Acompanhamentos do Dia <span id="sf-wa-followups-today-count" class="sf-day-shortcut-count sf-hidden-el"></span></button>
        </div>
        <div id="sf-wa-agenda-today" class="sf-day-shortcut-panel sf-hidden-el"></div>
        <div id="sf-wa-followups-today" class="sf-day-shortcut-panel sf-hidden-el"></div>
      </div>
      <div id="sf-wa-content-wrap">
        <div id="sf-wa-rail" class="sf-hidden-el">
          <button type="button" class="sf-rail-btn" data-target="sf-wa-crm-content" title="Oportunidade">${railOpportunitySVG()}</button>
          <button type="button" class="sf-rail-btn" data-target="sf-wa-agenda-today" data-expand="agenda" title="Agenda do Dia">${calendarSVG()}</button>
          <button type="button" class="sf-rail-btn" data-target="sf-wa-followups-today" data-expand="followups" title="Acompanhamentos do Dia">${checklistSVG()}</button>
          <button type="button" class="sf-rail-btn" data-target="sf-wa-prontuario" title="Prontuário">${railProntuarioSVG()}</button>
        </div>
        <div id="sf-wa-content">
          <div class="sf-loading"><div class="sf-spinner"></div> Carregando...</div>
        </div>
      </div>
      <div id="sf-wa-linked" class="sf-hidden-el">
        <p class="sf-linked-title">Contatos Vinculados</p>
        <div id="sf-wa-linked-list" class="sf-loading"><div class="sf-spinner"></div> Carregando...</div>
      </div>
      <div id="sf-wa-footer">
        <span id="sf-wa-updated">Aguardando contato...</span>
      </div>
    `;
  }

  // Tela inicial (nenhuma conversa aberta): além do aviso, a lista de leads —
  // dá para abrir a ficha e disparar a campanha sem precisar caçar a conversa
  // antes, já que quem abre a conversa é o "Enviar no WhatsApp" da própria
  // ficha (`openChatInPlace`).
  function emptyStateHTML() {
    return `
      <div id="sf-wa-home">
        <div id="sf-wa-empty">
          <img class="sf-empty-logo" src="${logoForContext('logo-sem-fundo1.png')}" alt="Elo Automações" />
          <p>Clique em um contato ou conversa para ver os dados disponíveis.</p>
        </div>
        ${crmSectionHTML(
          'Leads',
          `<div id="sf-wa-home-leads" class="sf-loading"><div class="sf-spinner"></div> Buscando leads...</div>`,
          'sf-wa-home-leads-section',
          `<button type="button" id="sf-wa-home-leads-refresh" class="sf-icon-btn" title="Atualizar lista">${refreshSVG()}</button>`,
        )}
      </div>
    `;
  }

  // ─── Auth (login embutido no painel) ──────────────────────────────────────

  function renderLoginView() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    sidebar.querySelector('#sf-wa-logout-btn').classList.add('sf-hidden-el');
    sidebar.querySelector('#sf-wa-home-btn').classList.add('sf-hidden-el');
    sidebar.querySelector('#sf-wa-refresh-btn').classList.add('sf-hidden-el');
    sidebar.querySelector('#sf-wa-linked-toggle-btn').classList.add('sf-hidden-el');
    sidebar.querySelector('#sf-wa-new-btn').classList.add('sf-hidden-el');
    closeCreateDropdown();
    sidebar.querySelector('#sf-wa-day-shortcuts').classList.add('sf-hidden-el');
    sidebar.querySelector('#sf-wa-rail').classList.add('sf-hidden-el');
    hideOpportunityBar();

    if (isLinkedView) {
      isLinkedView = false;
      sidebar.querySelector('#sf-wa-linked').classList.add('sf-hidden-el');
      sidebar.querySelector('#sf-wa-linked-toggle-btn').classList.remove('sf-active');
      sidebar.querySelector('#sf-wa-content-wrap').classList.remove('sf-hidden-el');
    }
    sidebar.querySelector('#sf-wa-content').classList.remove('sf-hidden-el');

    const content = sidebar.querySelector('#sf-wa-content');
    content.innerHTML = `
      <div id="sf-wa-login">
        <img class="sf-login-logo" src="${logoForContext('logo-sem-fundo1.png')}" alt="Elo Automações" />
        <p class="sf-login-title">Entre para liberar o painel</p>
        <form id="sf-wa-login-form">
          <label>Email</label>
          <input type="email" id="sf-wa-login-email" required autocomplete="username" />
          <label>Senha</label>
          <input type="password" id="sf-wa-login-password" required autocomplete="current-password" />
          <p class="sf-login-error" id="sf-wa-login-error"></p>
          <button type="submit" id="sf-wa-login-submit">Entrar</button>
        </form>
        <a class="sf-privacy-link" href="https://eloautomacoes.com.br/politica-de-privacidade" target="_blank" rel="noopener noreferrer">Política de Privacidade</a>
      </div>
    `;
    updateTimestamp('Faça login para continuar');

    content.querySelector('#sf-wa-login-form').addEventListener('submit', handleLoginSubmit);
  }

  function handleLoginSubmit(e) {
    e.preventDefault();
    const email = sidebar.querySelector('#sf-wa-login-email').value.trim();
    const password = sidebar.querySelector('#sf-wa-login-password').value;
    const errorEl = sidebar.querySelector('#sf-wa-login-error');
    const btn = sidebar.querySelector('#sf-wa-login-submit');

    errorEl.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Entrando...';

    chrome.runtime.sendMessage({ type: 'LOGIN', email, password }, (result) => {
      btn.disabled = false;
      btn.textContent = 'Entrar';

      if (!result || !result.ok) {
        errorEl.textContent = (result && result.error) || 'Erro ao conectar';
        errorEl.style.display = 'block';
        return;
      }

      onAuthenticated();
    });
  }

  function handleLogout() {
    chrome.runtime.sendMessage({ type: 'LOGOUT' }, () => {
      currentBranding = null;
      currentContact = {};
      renderLoginView();
    });
  }

  // ─── Contatos Vinculados (tab no header, via background.js) ──────────────

  function toggleLinkedView() {
    isLinkedView = !isLinkedView;
    sidebar.querySelector('#sf-wa-content-wrap').classList.toggle('sf-hidden-el', isLinkedView);
    sidebar.querySelector('#sf-wa-linked').classList.toggle('sf-hidden-el', !isLinkedView);
    sidebar.querySelector('#sf-wa-linked-toggle-btn').classList.toggle('sf-active', isLinkedView);
    if (isLinkedView) fetchLinkedList();
  }

  function fetchLinkedList() {
    const el = sidebar.querySelector('#sf-wa-linked-list');
    if (el) {
      el.className = 'sf-loading';
      el.innerHTML = `<div class="sf-spinner"></div> Carregando...`;
    }

    chrome.runtime.sendMessage({ type: 'GET_LINKED_OPPORTUNITIES' }, renderLinkedResult);
  }

  function renderLinkedResult(result) {
    const el = sidebar.querySelector('#sf-wa-linked-list');
    if (!el) return;
    el.className = '';

    if (!result || !result.ok) {
      el.innerHTML = `<span class="sf-field-value sf-empty">Erro ao buscar contatos vinculados.</span>`;
      return;
    }

    if (result.opportunities.length === 0) {
      el.innerHTML = `<span class="sf-field-value sf-empty">Nenhum contato vinculado ainda.</span>`;
      return;
    }

    el.innerHTML = renderLinkedListHTML(result.opportunities);
    wireLinkedList();
  }

  function renderLinkedListHTML(opportunities) {
    return `<div class="sf-linked-list">${opportunities.map(o => `
      <div class="sf-linked-item">
        <div class="sf-linked-info">
          <span class="sf-linked-name">${escHtml(o.name)}</span>
          <span class="sf-linked-whatsapp">WhatsApp: ${escHtml(o.whatsappName || '—')}</span>
          ${o.phone ? `<span class="sf-linked-phone">${escHtml(o.phone)}</span>` : ''}
        </div>
        <button type="button" class="sf-unlink-btn" data-id="${o.id}">Desvincular</button>
      </div>`).join('')}</div>`;
  }

  function wireLinkedList() {
    const el = sidebar.querySelector('#sf-wa-linked-list');
    if (!el) return;
    el.querySelectorAll('.sf-unlink-btn').forEach(btn => {
      btn.addEventListener('click', () => handleUnlinkFromList(btn));
    });
  }

  function handleUnlinkFromList(btn) {
    const opportunityId = Number(btn.getAttribute('data-id'));
    btn.disabled = true;
    btn.textContent = 'Removendo...';

    chrome.runtime.sendMessage({ type: 'UNLINK_OPPORTUNITY', opportunityId }, (result) => {
      if (!result || !result.ok) {
        btn.disabled = false;
        btn.textContent = 'Desvincular';
        return;
      }

      fetchLinkedList();
      // contato atual pode ser o mesmo que acabou de ser desvinculado
      if (currentContact.name) fetchCRMData(currentContact.name);
    });
  }

  // ─── Scraping ─────────────────────────────────────────────────────────────
  //
  // WhatsApp Web's class names are obfuscated and rotate on every release, so
  // instead of guessing class/testid strings we rely on stable HTML semantics:
  //   - the chat header is always a real <header> tag inside #main
  //   - WhatsApp puts the full (untruncated) name in a title="" attribute
  //   - phone numbers are wrapped in dir="ltr" spans so digits render correctly
  //   - panel sections show a label line followed by its value as a sibling

  let lastDebugHTML = '';

  // WhatsApp adds title="" to ANY truncated span (ellipsis), not specifically
  // the name — a long status line gets one too. So we can't pick "the span
  // with a title" as the name. Instead: the name is the first leaf text span
  // in the header, status is the second. As a safety net, if the first one
  // textually looks like a status phrase, swap them.
  function looksLikeStatus(text) {
    return /^(online|digitando|grav(ando|ação)|visto por último|last seen|\d+\s*(participantes?|members?))/i.test(text.trim());
  }

  function getHeaderParts() {
    const header = document.querySelector(SEL.mainHeader);
    if (!header) return { header: null, nameEl: null, subtitleEl: null };

    const leafSpans = Array.from(header.querySelectorAll('span'))
      .filter(el => !el.querySelector('span'))
      .filter(el => el.textContent.trim());

    // Primary: verified testid anchor on the title span. Fallback: first leaf
    // text span (skips the profile-photo button — it holds only an <img>).
    const titleAnchor = header.querySelector(SEL.chatTitleSpan);
    let nameEl = (titleAnchor && titleAnchor.textContent.trim())
      ? titleAnchor
      : (leafSpans[0] || null);
    let subtitleEl = leafSpans.find(el => el !== nameEl) || null;

    if (nameEl && looksLikeStatus(nameEl.textContent) &&
        subtitleEl && !looksLikeStatus(subtitleEl.textContent)) {
      [nameEl, subtitleEl] = [subtitleEl, nameEl];
    }

    return { header, nameEl, subtitleEl };
  }

  function scrapeContact() {
    const data = {
      name: null,
      phone: null,
      avatar: null,
      about: null,         // bio
      isGroup: false,
      isBusiness: false,
      businessCategory: null,
      groupDescription: null,
      groupParticipants: [],
    };

    const { header, nameEl } = getHeaderParts();
    if (!header) return data;

    // ── Name ──
    data.name =
      (nameEl && (nameEl.getAttribute('title') || nameEl.textContent.trim())) ||
      textOf(SEL.selectedChatTitle);

    // ── Avatar ──
    data.avatar = srcOfEl(header.querySelector('img')) || srcOf(SEL.selectedChatImg);

    // ── Phone ──
    data.phone = extractPhone(data.name);

    // ── About / Bio (panel: label "Sobre" / "About" then value) ──
    data.about = findLabeledValue(['Sobre', 'About']);

    // ── Business category ──
    const bizCat = findLabeledValue(['Categoria da empresa', 'Business category']);
    if (bizCat) {
      data.isBusiness = true;
      data.businessCategory = bizCat;
    }

    // ── Group detection ──
    const groupDesc = findLabeledValue(['Descrição do grupo', 'Group description']);
    if (groupDesc) {
      data.isGroup = true;
      data.groupDescription = groupDesc;
    }

    if (!data.name) {
      const html = header.outerHTML;
      if (html !== lastDebugHTML) {
        lastDebugHTML = html;
        console.log('[WA-PANEL] Nome não encontrado. Header atual:', header);
      }
    }

    return data;
  }

  // Looks for an element whose own text exactly matches one of the given
  // section labels, then reads the value from the next sibling element —
  // mirrors how WhatsApp's info panels lay out "label" then "value".
  function findLabeledValue(labels) {
    const candidates = document.querySelectorAll('#app span, #app div');
    for (const el of candidates) {
      if (el.children.length > 0) continue; // want leaf text nodes only
      const txt = el.textContent.trim();
      if (!labels.includes(txt)) continue;

      const container = el.closest('div');
      const valueContainer = container && container.nextElementSibling;
      const value = valueContainer ? valueContainer.textContent.trim() : '';
      if (value) return value;
    }
    return null;
  }

  function extractPhone(name) {
    // Unsaved contacts: WhatsApp shows the raw phone number as the chat name.
    if (name && isPhoneNumber(name)) return formatPhone(name);

    // Saved contacts: the number shows up in the contact-info panel inside a
    // dir="ltr" span (digits are forced left-to-right regardless of locale).
    const ltrSpans = document.querySelectorAll('#app span[dir="ltr"]');
    for (const el of ltrSpans) {
      const t = el.textContent.trim();
      if (isPhoneNumber(t)) return formatPhone(t);
    }

    return null;
  }

  // Última mensagem da conversa aberta (item 7 — bloco "Contexto da
  // Conversa"). WhatsApp historicamente expõe `data-pre-plain-text` nas
  // bolhas com "[HH:MM, DD/MM/AAAA] Nome: " — o padrão mais estável já
  // documentado para scraping do WhatsApp Web, mas NUNCA verificado contra o
  // DOM real deste projeto (ver docs/fase1-scraping-whatsapp.md, seção
  // "Limitações conhecidas"). Por isso falha em silêncio: se o atributo não
  // existir ou o formato mudar, retorna null e o bloco simplesmente some do
  // painel, sem quebrar o resto do render.
  function scrapeLastMessage() {
    try {
      const bubbles = document.querySelectorAll('#main [data-pre-plain-text]');
      if (!bubbles.length) return null;

      const last = bubbles[bubbles.length - 1];
      const meta = last.getAttribute('data-pre-plain-text') || '';
      const match = meta.match(/\[(\d{1,2}):(\d{2}),\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\]/);
      if (!match) return null;

      const [, hh, min, dd, mm, yyyy] = match;
      const when = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min));
      if (Number.isNaN(when.getTime())) return null;

      const textEl = last.querySelector('.selectable-text') || last;
      const text = (textEl.textContent || '').trim();
      if (!text) return null;

      const daysSince = Math.max(0, Math.floor((Date.now() - when.getTime()) / 86400000));
      return { text, daysSince };
    } catch (_) {
      return null;
    }
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  function scrapeAndRender(force = false) {
    const data = scrapeContact();

    if (!data.name) {
      if (force) renderEmpty();
      return;
    }

    // Avoid full re-render if same contact and not forced
    if (!force && data.name === currentContact.name) return;

    currentContact = data;
    lastChatTitle = data.name;
    renderContact(data);
    updateTimestamp();

    fetchCRMData(data.name);
  }

  function renderEmpty() {
    const content = sidebar.querySelector('#sf-wa-content');
    content.innerHTML = emptyStateHTML();
    currentContact = {};
    lastChatTitle = '';
    hideOpportunityBar();
    updateTimestamp('Aguardando contato...');
    wireHomeLeadsRefresh();
    loadHomeLeads();
  }

  // ─── Leads na tela inicial ────────────────────────────────────────────────
  //
  // Mesma lista da fila de pendentes, sem o botão "Vincular": vincular liga o
  // lead ao contato do WhatsApp que está na tela, e aqui não há nenhum. Sobra
  // o "Ver lead", que abre a ficha — e de lá a conversa.

  function loadHomeLeads() {
    if (!sidebar.querySelector('#sf-wa-home-leads')) return;
    chrome.runtime.sendMessage({ type: 'GET_PENDING_OPPORTUNITIES' }, renderHomeLeadsResult);
  }

  function wireHomeLeadsRefresh() {
    const btn = sidebar.querySelector('#sf-wa-home-leads-refresh');
    if (!btn) return;

    btn.addEventListener('click', () => {
      if (btn.classList.contains('sf-spinning')) return;
      btn.classList.add('sf-spinning');

      const el = sidebar.querySelector('#sf-wa-home-leads');
      if (el) {
        el.className = 'sf-loading';
        el.innerHTML = `<div class="sf-spinner"></div> Buscando leads...`;
      }

      chrome.runtime.sendMessage({ type: 'GET_PENDING_OPPORTUNITIES' }, (result) => {
        btn.classList.remove('sf-spinning');
        renderHomeLeadsResult(result);
      });
    });
  }

  function renderHomeLeadsResult(result) {
    // Sumiu do DOM = abriram uma conversa enquanto a resposta vinha.
    const el = sidebar.querySelector('#sf-wa-home-leads');
    if (!el) return;
    el.className = '';

    if (!result || !result.ok) {
      const msg = result && result.error === 'not_authenticated'
        ? 'Faça login na extensão (ícone na barra do Chrome) para ver os leads.'
        : 'Erro ao buscar os leads.';
      el.innerHTML = `<span class="sf-field-value sf-empty">${escHtml(msg)}</span>`;
      return;
    }

    if (result.opportunities.length === 0) {
      el.innerHTML = `<span class="sf-field-value sf-empty">Nenhum lead pendente.</span>`;
      return;
    }

    el.innerHTML = renderPendingListHTML(result.opportunities, { withLink: false });
    wirePendingList('', el);
  }

  function renderContact(d) {
    const content = sidebar.querySelector('#sf-wa-content');

    // Build sections
    let sections = '';

    // ── Sobre ──
    if (d.about) {
      sections += `<div class="sf-section">
        <p class="sf-section-title">Sobre</p>
        ${field('Bio', d.about)}
      </div>`;
    }

    // ── Grupo ──
    if (d.isGroup) {
      const membersHTML = d.groupParticipants.length > 0
        ? `<div class="sf-member-list">${d.groupParticipants.map(m => `
            <div class="sf-member-item">
              ${m.avatar
                ? `<img class="sf-member-avatar" style="width:28px;height:28px;border-radius:50%;object-fit:cover;" src="${m.avatar}" />`
                : `<div class="sf-member-avatar">${initials(m.name)}</div>`
              }
              <span class="sf-member-name">${escHtml(m.name)}</span>
              ${m.phone ? `<span class="sf-member-phone">${escHtml(m.phone)}</span>` : ''}
            </div>`).join('')}
          </div>`
        : `<span class="sf-field-value sf-empty">Abra o painel de info do grupo</span>`;

      sections += `<div class="sf-section">
        <p class="sf-section-title">Grupo</p>
        ${d.groupDescription ? field('Descrição', d.groupDescription) : ''}
        <div class="sf-field">
          <span class="sf-field-label">Participantes</span>
          ${membersHTML}
        </div>
      </div>`;
    }

    // ── Sistema (CRM) — preenchido de forma assíncrona via fetchCRMData ──
    sections += `<div id="sf-wa-crm-content"></div>`;

    content.innerHTML = `
      <div id="sf-wa-body">${sections}</div>
    `;

    // Wire copy buttons
    content.querySelectorAll('[data-copy]').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.getAttribute('data-copy');
        navigator.clipboard.writeText(val).then(() => {
          btn.textContent = '✓ Copiado';
          btn.classList.add('copied');
          setTimeout(() => {
            btn.textContent = 'Copiar';
            btn.classList.remove('copied');
          }, 1500);
        });
      });
    });
  }

  // ─── CRM Lookup (via background.js, que guarda o token) ──────────────────

  function fetchCRMData(name) {
    const el = sidebar.querySelector('#sf-wa-crm-content');
    if (el) el.innerHTML = crmSectionHTML('Sistema', `<div class="sf-loading"><div class="sf-spinner"></div> Buscando no sistema...</div>`);
    hideOpportunityBar();

    chrome.runtime.sendMessage({ type: 'LOOKUP_CONTACT', name }, (result) => {
      stopManualRefreshSpin();
      // Contato pode ter mudado enquanto a resposta ainda não chegou.
      if (currentContact.name !== name) return;
      renderCRMResult(result, name);
    });
  }

  function stopManualRefreshSpin() {
    const btn = sidebar.querySelector('#sf-wa-refresh-btn');
    if (btn) btn.classList.remove('sf-spinning');
  }

  function handleManualRefresh() {
    const btn = sidebar.querySelector('#sf-wa-refresh-btn');
    if (!btn || btn.classList.contains('sf-spinning')) return;
    btn.classList.add('sf-spinning');
    scrapeAndRender(true);
    // Sem contato detectado (force=true cai direto em renderEmpty, sem passar
    // por fetchCRMData) — nada dispara stopManualRefreshSpin, então garante aqui.
    if (!currentContact.name) stopManualRefreshSpin();
  }

  // Botão "Voltar ao início": mostra a tela inicial (logo + lista de leads)
  // independente do que estiver aberto no WhatsApp — diferente do refresh, que
  // re-escaneia a conversa atual.
  function handleGoHome() {
    if (isLinkedView) toggleLinkedView();
    closeCreateDropdown();
    renderEmpty();
  }

  function renderCRMResult(result, name) {
    const el = sidebar.querySelector('#sf-wa-crm-content');
    if (!el) return;

    if (!result || !result.ok) {
      const msg = result && result.error === 'not_authenticated'
        ? 'Faça login na extensão (clique no ícone na barra do Chrome) para ver dados do sistema.'
        : 'Erro ao buscar dados do sistema.';
      el.innerHTML = crmSectionHTML('Sistema', `<span class="sf-field-value sf-empty">${escHtml(msg)}</span>`);
      return;
    }

    if (!result.found) {
      renderPendingPicker(name);
      return;
    }

    const summary = computeQuickSummary(result.schedulings);
    el.innerHTML = conversationContextHTML(summary) + renderOpportunitySections(result);
    renderOpportunityBar(
      result.contact,
      summary,
      computeSuggestion(result.activities, result.schedulings)
    );
    const bar = sidebar.querySelector('#sf-wa-opportunity-bar');
    const unlinkBtn = bar && bar.querySelector('.sf-unlink-btn');
    if (unlinkBtn) unlinkBtn.addEventListener('click', () => handleUnlinkCurrent(unlinkBtn, name));
  }

  function handleUnlinkCurrent(btn, name) {
    const opportunityId = Number(btn.getAttribute('data-id'));
    btn.disabled = true;
    btn.textContent = 'Desvinculando...';

    chrome.runtime.sendMessage({ type: 'UNLINK_OPPORTUNITY', opportunityId }, (result) => {
      if (currentContact.name !== name) return;

      if (!result || !result.ok) {
        btn.disabled = false;
        btn.textContent = 'Desvincular';
        return;
      }

      fetchCRMData(name);
    });
  }

  // ─── Vincular contato a oportunidade pendente (quando não encontrado) ─────

  function renderPendingPicker(name) {
    const el = sidebar.querySelector('#sf-wa-crm-content');
    if (!el) return;

    el.innerHTML = crmSectionHTML('Sistema', `
      <span class="sf-field-value sf-empty">Nenhum dado encontrado para este nome.</span>
      <div id="sf-wa-pending-list" class="sf-loading"><div class="sf-spinner"></div> Buscando oportunidades pendentes...</div>
    `, '', `<button type="button" id="sf-wa-pending-refresh" class="sf-icon-btn" title="Atualizar lista">${refreshSVG()}</button>`);

    wirePendingRefreshButton(name);
    loadPendingOpportunities(name);
  }

  function loadPendingOpportunities(name) {
    chrome.runtime.sendMessage({ type: 'GET_PENDING_OPPORTUNITIES' }, (result) => {
      if (currentContact.name !== name) return;
      renderPendingResult(result, name);
    });
  }

  function wirePendingRefreshButton(name) {
    const btn = sidebar.querySelector('#sf-wa-pending-refresh');
    if (!btn) return;

    btn.addEventListener('click', () => {
      if (btn.classList.contains('sf-spinning')) return;
      btn.classList.add('sf-spinning');

      const listEl = sidebar.querySelector('#sf-wa-pending-list');
      if (listEl) {
        listEl.className = 'sf-loading';
        listEl.innerHTML = `<div class="sf-spinner"></div> Buscando oportunidades pendentes...`;
      }

      chrome.runtime.sendMessage({ type: 'GET_PENDING_OPPORTUNITIES' }, (result) => {
        btn.classList.remove('sf-spinning');
        if (currentContact.name !== name) return;
        renderPendingResult(result, name);
      });
    });
  }

  function renderPendingResult(result, name) {
    const el = sidebar.querySelector('#sf-wa-pending-list');
    if (!el) return;
    el.className = '';

    if (!result || !result.ok) {
      el.innerHTML = `<span class="sf-field-value sf-empty">Erro ao buscar oportunidades pendentes.</span>`;
      return;
    }

    if (result.opportunities.length === 0) {
      el.innerHTML = `<span class="sf-field-value sf-empty">Nenhuma oportunidade pendente.</span>`;
      return;
    }

    el.innerHTML = renderPendingListHTML(result.opportunities);
    wirePendingList(name);
  }

  function renderPendingListHTML(opportunities, { withLink = true } = {}) {
    return `
      <input type="text" class="sf-pending-search" placeholder="Filtrar por nome..." />
      <div class="sf-pending-list">
        ${opportunities.map(o => `
          <div class="sf-pending-item" data-name="${escHtml(o.name)}">
            <div class="sf-pending-info">
              <span class="sf-pending-name" title="${escHtml(o.name)}">${escHtml(o.name)}</span>
              ${o.phone ? `<span class="sf-pending-phone">${escHtml(o.phone)}</span>` : ''}
            </div>
            <div class="sf-pending-actions">
              <button type="button" class="sf-pending-view-btn" data-id="${o.id}">Ver lead</button>
              ${withLink ? `<button type="button" class="sf-pending-link-btn" data-id="${o.id}">Vincular</button>` : ''}
            </div>
          </div>`).join('')}
      </div>
    `;
  }

  function wirePendingList(name, container) {
    const el = container || sidebar.querySelector('#sf-wa-pending-list');
    if (!el) return;

    const search = el.querySelector('.sf-pending-search');
    if (search) {
      search.addEventListener('input', () => {
        const term = search.value.trim().toLowerCase();
        el.querySelectorAll('.sf-pending-item').forEach(item => {
          const itemName = item.getAttribute('data-name').toLowerCase();
          item.classList.toggle('sf-hidden-el', term.length > 0 && !itemName.includes(term));
        });
      });
    }

    el.querySelectorAll('.sf-pending-link-btn').forEach(btn => {
      btn.addEventListener('click', () => handleLinkOpportunity(btn, name));
    });

    el.querySelectorAll('.sf-pending-view-btn').forEach(btn => {
      const item = btn.closest('.sf-pending-item');
      const fallbackName = item ? item.getAttribute('data-name') : '';
      btn.addEventListener('click', () => openLeadModal(Number(btn.getAttribute('data-id')), fallbackName));
    });
  }

  function handleLinkOpportunity(btn, name) {
    const opportunityId = Number(btn.getAttribute('data-id'));
    btn.disabled = true;
    btn.textContent = 'Vinculando...';

    chrome.runtime.sendMessage({ type: 'LINK_OPPORTUNITY', opportunityId, name }, (result) => {
      if (currentContact.name !== name) return;

      if (!result || !result.ok) {
        btn.disabled = false;
        btn.textContent = 'Vincular';
        const el = sidebar.querySelector('#sf-wa-pending-list');
        if (el && !el.querySelector('.sf-link-error')) {
          const errEl = document.createElement('p');
          errEl.className = 'sf-link-error';
          errEl.textContent = 'Erro ao vincular contato.';
          el.prepend(errEl);
        }
        return;
      }

      fetchCRMData(name);
    });
  }

  // ─── Ficha do lead + envio de campanha ────────────────────────────────────
  //
  // Aberta pelo botão "Ver lead" da fila de pendentes, SEM vincular nada: é
  // justamente a tela onde o operador ainda decide se aquele lead é o contato
  // aberto na conversa. Mostra o momento do funil, os dados de contato e a
  // próxima ação; embaixo, escolhe-se uma Campanha ativa, a mensagem sugerida
  // dela cai no campo (editável) e vai pro WhatsApp.

  function openLeadModal(opportunityId, fallbackName) {
    const overlay = openModal(fallbackName || 'Lead', 'Carregando...', `
      <div class="sf-modal-body" id="sf-wa-lead-body">
        <div class="sf-loading"><div class="sf-spinner"></div> Carregando ficha do lead...</div>
      </div>
    `, 'Ficha do lead');

    chrome.runtime.sendMessage({ type: 'GET_LEAD_DETAIL', opportunityId }, (result) => {
      if (!overlay.isConnected) return; // modal já fechado quando a resposta chegou

      if (!result || !result.ok || !result.lead) {
        const body = overlay.querySelector('#sf-wa-lead-body');
        const msg = result && result.error === 'not_authenticated'
          ? 'Faça login na extensão (clique no ícone na barra do Chrome) para ver a ficha do lead.'
          : (result && result.error) || 'Erro ao carregar a ficha do lead.';
        body.innerHTML = `<span class="sf-field-value sf-empty">${escHtml(msg)}</span>`;
        return;
      }

      renderLeadModal(overlay, result.lead);
    });
  }

  function renderLeadModal(overlay, lead) {
    const titleEl = overlay.querySelector('.sf-modal-title');
    const subtitleEl = overlay.querySelector('.sf-modal-subtitle');
    if (titleEl) titleEl.textContent = lead.name;
    if (subtitleEl) subtitleEl.textContent = lead.phone ? formatPhone(lead.phone) : 'Sem telefone cadastrado';

    const cityUf = [lead.city, lead.state].filter(Boolean).join(' / ');
    const body = overlay.querySelector('#sf-wa-lead-body');

    body.innerHTML = `
      ${leadFunnelHTML(lead.funnel)}
      <div class="sf-lead-grid">
        ${leadCellHTML('Telefone', lead.phone ? formatPhone(lead.phone) : '', 'sf-lead-value-mono')}
        ${leadCellHTML('Origem', lead.sourceLabel)}
        ${lead.isProspect
          ? leadCellHTML('Toques enviados', `${lead.contactCount} de 6`, 'sf-lead-value-mono')
          : leadCellHTML('Potencial', lead.potential)}
        ${leadCellHTML('Responsável pela conta', lead.contactName)}
        ${leadCellHTML('Responsável interno', lead.responsibleName)}
        ${leadCellHTML('Cidade / UF', cityUf)}
        ${leadCellHTML('E-mail', lead.email)}
        ${lead.instagram ? leadCellHTML('Instagram', lead.instagram) : ''}
        ${lead.website ? leadCellHTML('Site', lead.website) : ''}
        ${leadCellHTML('Cadastrado em', formatIsoDate(lead.createdAt), 'sf-lead-value-mono')}
        ${leadCellHTML('Atualizado em', formatIsoDate(lead.lastModifiedAt), 'sf-lead-value-mono')}
        ${lead.lostReasonLabel ? leadCellHTML('Motivo da perda', lead.lostReasonLabel) : ''}
      </div>
      ${lead.notes ? `
        <span class="sf-modal-label">Observações</span>
        <div class="sf-lead-notes">${escHtml(lead.notes)}</div>` : ''}
      ${leadNextActionHTML(lead)}
      ${leadCampaignHTML(lead)}
      <a class="sf-lead-open-link" href="${escHtml(lead.profileUrl)}" title="${escHtml(lead.profileUrl)}" target="_blank" rel="noopener noreferrer">Abrir ficha completa no sistema</a>
    `;

    wireLeadCampaign(overlay, lead);
  }

  function leadCellHTML(label, value, extraClass = '') {
    return `
      <div class="sf-lead-cell">
        <span class="sf-lead-label">${escHtml(label)}</span>
        ${value
          ? `<span class="sf-lead-value ${extraClass}">${escHtml(value)}</span>`
          : `<span class="sf-lead-value sf-empty">—</span>`}
      </div>`;
  }

  // Momento do funil: etapa atual + trilha de progresso. `step` vem nulo em
  // desfecho lateral (Perdido/Cancelado), que não tem posição na sequência.
  function leadFunnelHTML(funnel) {
    if (!funnel) return '';
    const total = funnel.total || 0;
    const step = funnel.step || 0;
    const track = Array.from({ length: total }, (_, i) =>
      `<span class="sf-lead-step${i < step ? ' sf-lead-step-done' : ''}"></span>`).join('');

    return `
      <div class="sf-lead-funnel">
        <div class="sf-lead-funnel-head">
          <span class="sf-lead-funnel-stage">${escHtml(funnel.label)}</span>
          ${step ? `<span class="sf-lead-funnel-count">${step} de ${total}</span>` : ''}
        </div>
        ${total ? `<div class="sf-lead-funnel-track">${track}</div>` : ''}
        ${funnel.kindLabel ? `<span class="sf-lead-funnel-kind">${escHtml(funnel.kindLabel)}</span>` : ''}
      </div>
    `;
  }

  function leadNextActionHTML(lead) {
    const na = lead.nextAction;
    if (!na) return '';
    const when = na.date ? formatDateLabel(na.date) : '';
    return `
      <span class="sf-modal-label">Próxima ação</span>
      <div class="sf-lead-action-box">
        <div class="sf-lead-action-head">
          <span class="sf-lead-action-type">${escHtml(na.typeLabel || '—')}</span>
          ${when ? `<span class="sf-lead-action-date">${escHtml(when)}</span>` : ''}
        </div>
        ${na.description ? `<p class="sf-lead-action-desc">${escHtml(na.description)}</p>` : ''}
        ${na.suggestionMessage
          ? `<button type="button" class="sf-lead-use-suggestion">Usar a mensagem desta ação</button>`
          : ''}
      </div>
    `;
  }

  function leadCampaignHTML(lead) {
    return `
      <div class="sf-lead-campaign">
        <span class="sf-modal-label">Campanha</span>
        ${customSelectHTML({ name: 'campaign_id', placeholder: 'Carregando campanhas...' })}
        <span class="sf-modal-label">Mensagem</span>
        <textarea id="sf-wa-lead-msg" rows="6" class="sf-modal-input sf-modal-textarea sf-lead-msg"
                  placeholder="Escolha uma campanha para carregar a mensagem sugerida — dá para editar antes de enviar."></textarea>
        <p class="sf-lead-hint sf-lead-hint-warn" id="sf-wa-lead-msg-hint"></p>
        <div class="sf-lead-msg-actions">
          <button type="button" class="sf-lead-copy-btn">Copiar</button>
          <button type="button" class="sf-lead-wa-btn"${lead.phone ? '' : ' disabled'}>Enviar no WhatsApp</button>
        </div>
        ${lead.phone ? '' : `<p class="sf-lead-hint">Lead sem telefone cadastrado — não dá para abrir a conversa.</p>`}
      </div>
    `;
  }

  // Emojis (blocos Unicode de pictogramas/símbolos/bandeiras + seletor de
  // variação/ZWJ que os combina) e URLs cru — a mensagem de campanha vira
  // texto simples, sem os links de rastreio/mídia que antes entravam
  // colados no corpo (ver `buildCampaignMessage` abaixo).
  function stripLinksAndEmojis(text) {
    return String(text || '')
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/\bwww\.\S+/gi, '')
      .replace(/[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️‍]/gu, '')
      .split('\n')
      .map(line => line.replace(/[ \t]+$/g, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // O app grava o texto da campanha e o link separados — mas o envio por
  // WhatsApp agora leva só o texto (sem links, sem emojis; ver
  // `stripLinksAndEmojis`), que segue editável até o clique em Enviar.
  function buildCampaignMessage(campaign, lead) {
    const clean = stripLinksAndEmojis(campaign.messageText);
    return applyLeadPlaceholders(clean, lead);
  }

  // ─── Variáveis {{...}} do texto da campanha ───────────────────────────────
  //
  // O texto é escrito uma vez em /campanhas e enviado para muitos leads, então
  // vem com marcadores (`Olá, Dra. {{Nome}}!`). A troca acontece aqui, no envio,
  // porque é o único ponto que conhece o lead. Marcador desconhecido ou sem dado
  // fica INTACTO no texto — sumir com ele produziria "Olá, Dra. !" sem ninguém
  // perceber; deixado à vista, o operador corrige antes de mandar.
  //
  // Nome da variável é comparado sem acento, sem caixa e sem espaços:
  // {{Nome}}, {{ nome }} e {{NOME}} são a mesma coisa.

  function normalizePlaceholderKey(key) {
    return key
      .trim()
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[\s-]+/g, '_');
  }

  function leadPlaceholderValues(lead) {
    // `contactName` é a pessoa ("Responsável pela conta"); `name` é a clínica.
    // Saudação pede a pessoa — a clínica entra só como último recurso, e nesse
    // caso `applyLeadPlaceholders` avisa.
    const person = (lead.contactName || '').trim();
    const company = (lead.name || '').trim();
    const greeting = person || company;

    return {
      nome: greeting,
      primeiro_nome: greeting.split(/\s+/)[0] || '',
      contato: person,
      clinica: company,
      empresa: company,
      cidade: (lead.city || '').trim(),
      estado: (lead.state || '').trim(),
      uf: (lead.state || '').trim(),
      telefone: lead.phone ? formatPhone(lead.phone) : '',
    };
  }

  /** Troca as variáveis e devolve `{ text, notes }` — `notes` alimenta o aviso do modal. */
  function applyLeadPlaceholders(text, lead) {
    const values = leadPlaceholderValues(lead);
    const missing = new Set();
    const usedCompanyAsPerson = { flag: false };

    const result = String(text || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (token, rawKey) => {
      const key = normalizePlaceholderKey(rawKey);
      const value = values[key];
      if (!value) { missing.add(token.trim()); return token; }
      if ((key === 'nome' || key === 'primeiro_nome') && !lead.contactName) usedCompanyAsPerson.flag = true;
      return value;
    });

    const notes = [];
    if (usedCompanyAsPerson.flag) {
      notes.push('Lead sem "Responsável pela conta" — o nome usado foi o da clínica. Confira o tratamento antes de enviar.');
    }
    if (missing.size) {
      notes.push(`Sem dado para ${[...missing].join(', ')} — preencha à mão.`);
    }
    return { text: result, notes };
  }

  /** Linha de aviso embaixo da mensagem — variáveis sem dado ou falha ao abrir a conversa. */
  function setLeadHint(overlay, message) {
    const hint = overlay.querySelector('#sf-wa-lead-msg-hint');
    if (!hint) return;
    hint.textContent = message;
    hint.style.display = message ? 'block' : 'none';
  }

  /** Escreve no campo e atualiza o aviso de variáveis. */
  function setLeadMessage(overlay, filled) {
    const textarea = overlay.querySelector('#sf-wa-lead-msg');
    if (!textarea) return;

    textarea.value = filled ? filled.text : '';
    setLeadHint(overlay, ((filled && filled.notes) || []).join(' '));
  }

  function wireLeadCampaign(overlay, lead) {
    const widget = overlay.querySelector('.sf-lead-campaign .sf-select');
    const textarea = overlay.querySelector('#sf-wa-lead-msg');
    if (!widget || !textarea) return;

    const valueEl = widget.querySelector('.sf-select-value');
    let campaigns = [];
    // Nome da campanha escolhida — vai junto do envio só para aparecer na
    // linha do tempo ("Campanha X"). Fica nulo quando o texto veio da próxima
    // ação ou foi digitado à mão.
    let selectedCampaignName = null;

    chrome.runtime.sendMessage({ type: 'GET_CAMPAIGNS' }, (result) => {
      if (!widget.isConnected) return;

      if (!result || !result.ok) { valueEl.textContent = 'Erro ao carregar campanhas'; return; }
      campaigns = result.campaigns || [];
      if (!campaigns.length) { valueEl.textContent = 'Nenhuma campanha ativa'; return; }

      // Campanha de outro canal continua na lista (o texto serve), mas vem
      // marcada — o envio daqui é sempre WhatsApp.
      const options = [
        { id: '', name: 'Selecione a campanha...' },
        ...campaigns.map(c => ({
          id: c.id,
          name: c.channel === 'WHATSAPP' ? c.name : `${c.name} · ${c.channelLabel}`,
        })),
      ];

      wireCustomSelect(widget, options, {
        value: '',
        onChange: (id) => {
          const campaign = campaigns.find(c => String(c.id) === String(id));
          selectedCampaignName = campaign ? campaign.name : null;
          setLeadMessage(overlay, campaign ? buildCampaignMessage(campaign, lead) : null);
        },
      });
    });

    const useBtn = overlay.querySelector('.sf-lead-use-suggestion');
    if (useBtn) {
      useBtn.addEventListener('click', () => {
        // Mesmas variáveis da campanha: a mensagem da próxima ação também é
        // escrita antes de saber para quem vai.
        selectedCampaignName = null;
        setLeadMessage(overlay, applyLeadPlaceholders(lead.nextAction.suggestionMessage, lead));
        textarea.focus();
      });
    }

    const copyBtn = overlay.querySelector('.sf-lead-copy-btn');
    copyBtn.addEventListener('click', () => {
      const text = textarea.value.trim();
      if (!text) { textarea.focus(); return; }
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = 'Copiado!';
        setTimeout(() => { if (copyBtn.isConnected) copyBtn.textContent = 'Copiar'; }, 2000);
      });
    });

    const waBtn = overlay.querySelector('.sf-lead-wa-btn');
    // Abre a conversa do telefone DO LEAD (não a que está na tela) aqui mesmo
    // no WhatsApp Web, sem reload e sem aba nova — ver `openChatInPlace`. Em
    // seguida, o MESMO clique avança o funil, assume o lead e fecha o modal,
    // que cobre justamente a conversa que a pessoa precisa conferir antes de
    // apertar Enter.
    //
    // O funil avança mesmo quando a conversa não abre (pedido explícito: o
    // clique é o registro do toque, e travar o funil por causa do DOM do
    // WhatsApp deixava o operador sem saída). O que NÃO acontece nesse caso é
    // o vínculo: `chatOpened` falso significa que a conversa na tela não é
    // comprovadamente a do lead, e vincular ali grudaria a oportunidade na
    // conversa errada. O motivo da falha vai para o rodapé e para o console.
    waBtn.addEventListener('click', async () => {
      const text = textarea.value.trim();
      if (!text) { textarea.focus(); return; }

      waBtn.disabled = true;
      waBtn.textContent = 'Abrindo conversa...';
      setLeadHint(overlay, '');

      const chat = await openChatInPlace(lead.phone, text);
      if (chat.ok) {
        waBtn.classList.add('sf-lead-wa-btn-sent');
      } else {
        // O modal fecha de todo jeito, e fecharia levando a mensagem junto —
        // ela vai para a área de transferência para poder ser colada à mão.
        try { await navigator.clipboard.writeText(text); } catch (_) { /* sem clipboard, resta o console */ }
        console.warn('[WA-PANEL] Mensagem que ficou na área de transferência:', text);
      }

      waBtn.textContent = 'Atualizando o CRM...';
      const result = await registerLeadSend(lead, selectedCampaignName, chat.chatOpened === true);

      closeModal();
      const summary = leadSendSummary(chat, result);
      updateTimestamp(summary);
      showFlash(summary, result && result.ok ? 'ok' : 'error');
      if (!chat.ok) console.warn('[WA-PANEL] Funil atualizado sem abrir a conversa:', chat.reason);
      if (result && result.notes && result.notes.length) {
        console.warn('[WA-PANEL] Envio registrado com ressalvas:', result.notes);
      }
    });
  }

  /**
   * Registra o envio no CRM: avança o funil, atribui o lead a quem enviou e —
   * só quando `canLink` — vincula a oportunidade à conversa aberta.
   *
   * O vínculo usa o TÍTULO da conversa — nome do contato salvo ou, no caso
   * comum do lead de scraping, o próprio número — porque é por ele que
   * `LOOKUP_CONTACT` reencontra o registro nas próximas aberturas. Só cai no
   * telefone da ficha se o cabeçalho não puder ser lido.
   */
  function registerLeadSend(lead, campaignName, canLink) {
    const whatsappName = canLink
      ? (scrapeContact().name || formatPhone(lead.phone) || lead.phone)
      : null;

    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'REGISTER_WHATSAPP_SEND',
        opportunityId: lead.id,
        whatsappName,
        campaignName: campaignName || null,
      }, resolve);
    });
  }

  /** Linha do rodapé depois do envio — o modal já fechou, é o único retorno visível. */
  function leadSendSummary(chat, result) {
    if (!result || !result.ok) {
      return `Funil NÃO atualizado: ${(result && result.error) || 'falha ao falar com a API'}`;
    }

    const parts = [
      result.advanced ? `funil em "${result.stageLabel}"` : `funil mantido em "${result.stageLabel}"`,
      result.assigned ? 'lead atribuído a você' : null,
      result.linkedName ? 'conversa vinculada' : null,
      chat.ok ? null : 'a conversa não abriu (mensagem copiada) — veja o console',
      chat.warning ? 'confira o texto no campo antes de enviar' : null,
    ].filter(Boolean);

    return `Envio registrado — ${parts.join(' · ')}`;
  }

  function crmSectionHTML(title, inner, id = '', actionsHTML = '') {
    const actions = actionsHTML ? `<span class="sf-section-title-actions">${actionsHTML}</span>` : '';
    return `<div class="sf-section"${id ? ` id="${id}"` : ''}><p class="sf-section-title">${escHtml(title)}${actions}</p>${inner}</div>`;
  }

  // Bloco "Contexto da Conversa" (item 7) — "Tratamento" vem do resumo rápido
  // (já calculado a partir dos agendamentos); "Última conversa" vem do
  // scraping best-effort da última mensagem no WhatsApp (`scrapeLastMessage`).
  // Some inteiro quando nenhuma das duas partes tem dado — evita seção vazia.
  function conversationContextHTML(summary) {
    const lastMsg = scrapeLastMessage();
    const hasTreatment = summary && summary.treatment;
    if (!lastMsg && !hasTreatment) return '';

    let inner = '';
    if (hasTreatment) inner += field('Tratamento', summary.treatment);
    if (lastMsg) {
      const daysLabel = lastMsg.daysSince === 0 ? 'Hoje' : lastMsg.daysSince === 1 ? 'Há 1 dia' : `Há ${lastMsg.daysSince} dias`;
      inner += field('Última conversa', `“${lastMsg.text}”`, 'sf-context-quote', `<span class="sf-field-sub">${escHtml(daysLabel)}</span>`);
    }

    return crmSectionHTML('Contexto da Conversa', inner);
  }

  function renderOpportunitySections({ activities = [], schedulings = [] }) {
    // Mescla atividades e agendamentos numa única timeline cronológica (mais
    // recente primeiro) — o clique resolve o item pelo índice nessa mesma lista.
    const merged = [
      ...activities.slice(0, 5).map(a => ({ ...a, _kind: 'activity' })),
      ...schedulings.slice(0, 5).map(s => ({ ...s, _kind: 'scheduling' })),
    ].sort((a, b) => `${b.date || ''} ${b.hour || ''}`.localeCompare(`${a.date || ''} ${a.hour || ''}`));

    lastTimelineItems = merged;
    if (!merged.length) return '';
    return crmSectionHTML('Linha do Tempo', renderTimelineList(merged), 'sf-wa-prontuario');
  }

  function renderOpportunityActions(contact) {
    if (!contact) return '';
    return `
      <div class="sf-opportunity-actions">
        ${contact.profileUrl ? `<a class="sf-profile-link" href="${escHtml(contact.profileUrl)}" title="${escHtml(contact.profileUrl)}" target="_blank" rel="noopener noreferrer">Abrir paciente ↗</a>` : ''}
        ${contact.id ? `<button type="button" class="sf-unlink-btn" data-id="${contact.id}">Desvincular</button>` : ''}
      </div>
    `;
  }

  // ─── Dropdown "+ Novo" ──────────────────────────────────────────────────

  function toggleCreateDropdown() {
    isNewMenuOpen = !isNewMenuOpen;
    sidebar.querySelector('#sf-wa-new-menu').classList.toggle('sf-hidden-el', !isNewMenuOpen);
  }

  function closeCreateDropdown() {
    isNewMenuOpen = false;
    sidebar.querySelector('#sf-wa-new-menu').classList.add('sf-hidden-el');
  }

  // Agendamento/Acompanhamento/Histórico sempre abrem — quando não há uma
  // oportunidade vinculada ao contato atual, o próprio modal deixa buscar,
  // escolher ou criar uma (igual ao painel web). Criar oportunidade é a única
  // ação vedada a PROFISSIONAL (mesma regra de permissão do painel).
  function updateNewMenuAvailability() {
    const oppItem = sidebar.querySelector('#sf-wa-new-opportunity-item');
    if (oppItem) oppItem.classList.toggle('sf-hidden-el', currentUserRole === 'PROFISSIONAL');
  }

  function openCreateModal(kind) {
    closeCreateDropdown();
    if (kind === 'scheduling') openSchedulingModal();
    else if (kind === 'activity') openActivityModal();
    else if (kind === 'event') openEventModal();
    else if (kind === 'opportunity') openNewOpportunityModal();
  }

  // ─── Modal genérico (hero navy — porte de ModalHeader.tsx) ────────────────

  function buildModalOverlay(id, title, subtitle, bodyHTML, eyebrow) {
    const overlay = document.createElement('div');
    overlay.id = id;
    overlay.className = 'sf-modal-overlay';
    overlay.innerHTML = `
      <div class="sf-modal">
        <div class="sf-modal-header">
          <button type="button" class="sf-modal-close" title="Fechar">${closeSVG()}</button>
          ${eyebrow ? `<p class="sf-modal-eyebrow">${escHtml(eyebrow)}</p>` : ''}
          <p class="sf-modal-title">${escHtml(title)}</p>
          ${subtitle ? `<p class="sf-modal-subtitle">${escHtml(subtitle)}</p>` : ''}
        </div>
        ${bodyHTML}
      </div>
    `;
    document.body.appendChild(overlay);
    return overlay;
  }

  function closeModal() {
    const overlay = document.getElementById('sf-wa-modal-overlay');
    if (overlay) overlay.remove();
  }

  function openModal(title, subtitle, bodyHTML, eyebrow) {
    closeModal();
    const overlay = buildModalOverlay('sf-wa-modal-overlay', title, subtitle, bodyHTML, eyebrow);

    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    overlay.querySelector('.sf-modal-close').addEventListener('click', closeModal);
    const cancelBtn = overlay.querySelector('.sf-modal-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

    return overlay;
  }

  // Modal aninhado (ex.: "+ Nova oportunidade" aberto de dentro de Agendamento/
  // Acompanhamento/Histórico) — overlay com ID próprio, nunca reaproveita
  // #sf-wa-modal-overlay, pra não fechar/perder os dados do formulário pai que
  // continua aberto atrás (mesmo empilhamento do NewOpportunityModal no web).
  function closeNestedModal() {
    const overlay = document.getElementById('sf-wa-modal-overlay-nested');
    if (overlay) overlay.remove();
  }

  function openNestedModal(title, subtitle, bodyHTML, eyebrow) {
    closeNestedModal();
    const overlay = buildModalOverlay('sf-wa-modal-overlay-nested', title, subtitle, bodyHTML, eyebrow);
    overlay.classList.add('sf-modal-overlay-nested');

    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeNestedModal(); });
    overlay.querySelector('.sf-modal-close').addEventListener('click', closeNestedModal);
    const cancelBtn = overlay.querySelector('.sf-modal-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', closeNestedModal);

    return overlay;
  }

  // ─── Combobox "Paciente / Oportunidade" ────────────────────────────────────
  // Reaproveitado pelos 3 modais de criação rápida (Agendamento/Acompanhamento/
  // Histórico): quando há uma oportunidade vinculada ao contato do WhatsApp
  // aberto, o campo fica travado (somente leitura); senão vira uma busca por
  // nome/telefone/CPF/e-mail — igual ao combobox do painel web — com uma opção
  // fixa "+ Nova oportunidade" que cria sem sair do modal atual.
  //
  // Diferente do painel web (onde Acompanhamento aceita "Sem vínculo"), aqui a
  // oportunidade é SEMPRE obrigatória nos 3 modais — pedido explícito do
  // usuário para a extensão.

  function opportunityFieldHTML() {
    if (currentOpportunity && currentOpportunity.id) {
      return `
        <label class="sf-modal-label">Paciente / Oportunidade</label>
        <input type="hidden" name="opportunity_id" value="${currentOpportunity.id}" />
        <div class="sf-modal-input sf-modal-input-readonly">${escHtml(currentOpportunity.name)}</div>
      `;
    }
    return `
      <label class="sf-modal-label">Paciente / Oportunidade *</label>
      <div class="sf-opp-combo" id="sf-wa-opp-combo">
        <input type="hidden" name="opportunity_id" value="" />
        <input type="text" class="sf-modal-input sf-opp-combo-input" autocomplete="off"
               placeholder="Buscar por nome, telefone, CPF ou e-mail…" />
        <div class="sf-opp-combo-list sf-hidden-el"></div>
      </div>
    `;
  }

  // Deve ser chamado logo após inserir `opportunityFieldHTML()` no DOM do modal.
  // Sem efeito quando o campo está travado (contato já vinculado).
  function wireOpportunityCombo(overlay) {
    const combo = overlay.querySelector('#sf-wa-opp-combo');
    if (!combo) return;

    const hidden = combo.querySelector('input[type="hidden"]');
    const input = combo.querySelector('.sf-opp-combo-input');
    const list = combo.querySelector('.sf-opp-combo-list');
    let allOpps = [];
    let loaded = false;
    let matches = [];
    let highlight = 0;

    chrome.runtime.sendMessage({ type: 'GET_OPPORTUNITIES' }, (result) => {
      loaded = true;
      if (!input.isConnected) return; // modal já fechado quando a resposta chegou
      allOpps = (result && result.ok && result.opportunities) || [];
      if (document.activeElement === input) renderList();
    });

    function filterOpps(query) {
      const q = query.trim().toLowerCase();
      if (!q) return allOpps.slice(0, 8);
      const digits = EloMasks.onlyDigits(q);
      return allOpps.filter(o => {
        if ((o.name || '').toLowerCase().includes(q)) return true;
        if (o.email && o.email.toLowerCase().includes(q)) return true;
        if (digits) {
          if (EloMasks.onlyDigits(o.phone || '').includes(digits)) return true;
          if (EloMasks.onlyDigits(o.document || '').includes(digits)) return true;
        }
        return false;
      }).slice(0, 8);
    }

    function highlightItem() {
      list.querySelectorAll('.sf-opp-combo-item').forEach((el, i) => {
        el.classList.toggle('sf-opp-combo-item-active', i === highlight);
      });
    }

    function renderList() {
      matches = filterOpps(input.value);
      highlight = 0;

      const itemsHTML = matches.map((o, i) => `
        <button type="button" class="sf-opp-combo-item" data-idx="${i}">
          <span class="sf-opp-combo-name">${escHtml(o.name)}</span>
          ${(o.phone || o.document || o.email) ? `<span class="sf-opp-combo-sub">${escHtml([
            o.phone && EloMasks.maskPhone(o.phone),
            o.document && EloMasks.maskCpfCnpj(o.document),
            o.email,
          ].filter(Boolean).join(' · '))}</span>` : ''}
        </button>`).join('');

      const emptyHTML = !loaded
        ? `<div class="sf-opp-combo-empty">Carregando...</div>`
        : (input.value.trim() && matches.length === 0)
          ? `<div class="sf-opp-combo-empty">Nenhum resultado encontrado.</div>`
          : '';

      list.innerHTML = `
        ${itemsHTML}${emptyHTML}
        <button type="button" class="sf-opp-combo-create" id="sf-wa-opp-combo-create">${plusSVG()} Nova oportunidade</button>
      `;
      list.classList.remove('sf-hidden-el');
      highlightItem();

      list.querySelectorAll('.sf-opp-combo-item').forEach(btn => {
        // mousedown + preventDefault (não click): evita que o blur do input feche
        // a lista antes do clique ser processado — mesmo truque do combobox web.
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          pick(matches[Number(btn.getAttribute('data-idx'))]);
        });
      });
      list.querySelector('#sf-wa-opp-combo-create').addEventListener('mousedown', (e) => {
        e.preventDefault();
        openNewOpportunityModal({ onCreated: pick });
      });
    }

    function pick(o) {
      hidden.value = String(o.id);
      input.value = o.name;
      list.classList.add('sf-hidden-el');
    }

    input.addEventListener('focus', renderList);
    input.addEventListener('input', () => { hidden.value = ''; renderList(); });
    input.addEventListener('blur', () => list.classList.add('sf-hidden-el'));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (list.classList.contains('sf-hidden-el')) { renderList(); return; }
        highlight = Math.min(highlight + 1, matches.length - 1);
        highlightItem();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        highlight = Math.max(highlight - 1, 0);
        highlightItem();
      } else if (e.key === 'Enter' && !list.classList.contains('sf-hidden-el') && matches[highlight]) {
        e.preventDefault();
        pick(matches[highlight]);
      } else if (e.key === 'Escape') {
        list.classList.add('sf-hidden-el');
      }
    });
  }

  // Sugestões de Origem — mesmos rótulos padrão do painel web (`SOURCE_LABELS`);
  // o backend aceita tanto esses valores quanto texto livre (origem customizada
  // do tenant), então isto é só um datalist de conveniência, não uma trava.
  const OPPORTUNITY_SOURCE_SUGGESTIONS = ['WhatsApp', 'Instagram', 'Facebook', 'Google', 'Indicação', 'Site', 'Telefone', 'Outros'];

  // ─── Modal: Nova Oportunidade ───────────────────────────────────────────
  // Aberto tanto pelo dropdown "+ Novo" (standalone) quanto pelo "+ Nova
  // oportunidade" dentro do combobox dos outros 3 modais (com `onCreated`).

  function openNewOpportunityModal({ onCreated } = {}) {
    const overlay = openNestedModal('Nova oportunidade', '', `
      <form id="sf-wa-new-opp-form" class="sf-modal-body">
        <label class="sf-modal-label">Nome *</label>
        <input class="sf-modal-input" type="text" name="name" required autofocus placeholder="Nome da oportunidade" />

        <div class="sf-modal-grid-2">
          <div>
            <label class="sf-modal-label">Telefone / WhatsApp</label>
            <input class="sf-modal-input" type="text" name="phone" placeholder="(00) 00000-0000" />
          </div>
          <div>
            <label class="sf-modal-label">Origem</label>
            <input class="sf-modal-input" type="text" name="opportunity_source" list="sf-wa-opp-source-list" placeholder="Ex: WhatsApp, Site..." />
            <datalist id="sf-wa-opp-source-list">
              ${OPPORTUNITY_SOURCE_SUGGESTIONS.map(o => `<option value="${escHtml(o)}"></option>`).join('')}
            </datalist>
          </div>
        </div>

        <label class="sf-modal-label">E-mail</label>
        <input class="sf-modal-input" type="email" name="email" placeholder="email@exemplo.com" />

        <label class="sf-modal-label">Observação</label>
        <textarea class="sf-modal-input sf-modal-textarea" name="description" rows="2" placeholder="Anotações iniciais sobre a oportunidade…"></textarea>

        <p class="sf-modal-error" id="sf-wa-new-opp-error"></p>
        <div class="sf-modal-actions">
          <button type="button" class="sf-modal-cancel">Cancelar</button>
          <button type="submit" class="sf-modal-submit">Criar oportunidade</button>
        </div>
      </form>
    `, 'Oportunidades');

    const phoneInput = overlay.querySelector('input[name="phone"]');
    phoneInput.addEventListener('input', () => { phoneInput.value = EloMasks.maskPhone(phoneInput.value); });

    overlay.querySelector('#sf-wa-new-opp-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const form = e.target;
      const errorEl = form.querySelector('#sf-wa-new-opp-error');
      errorEl.textContent = '';

      const fd = new FormData(form);
      const name = (fd.get('name') || '').trim();
      if (!name) {
        errorEl.textContent = 'Informe o nome da oportunidade.';
        return;
      }

      const submitBtn = form.querySelector('.sf-modal-submit');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Criando...';

      chrome.runtime.sendMessage({
        type: 'CREATE_OPPORTUNITY',
        fields: {
          name,
          phone: fd.get('phone') || '',
          email: (fd.get('email') || '').trim(),
          opportunity_source: (fd.get('opportunity_source') || '').trim(),
          description: (fd.get('description') || '').trim(),
        },
      }, (result) => {
        if (!form.isConnected) return; // modal fechado enquanto a chamada rodava

        if (!result || !result.ok || result.id == null) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Criar oportunidade';
          errorEl.textContent = (result && result.error) || 'Erro ao criar oportunidade.';
          return;
        }

        closeNestedModal();
        if (onCreated) onCreated({ id: result.id, name });
      });
    });
  }

  // ─── Modal: Novo Agendamento ────────────────────────────────────────────

  function openSchedulingModal() {
    const today = new Date().toISOString().slice(0, 10);
    const overlay = openModal('Novo Agendamento', '', `
      <form id="sf-wa-modal-form" class="sf-modal-body">
        ${opportunityFieldHTML()}
        <div id="sf-wa-modal-professional-field">
          <label class="sf-modal-label">Profissional responsável</label>
          ${customSelectHTML({ name: 'responsible_user', placeholder: 'Carregando...' })}
        </div>
        <div class="sf-modal-grid-2">
          <div>
            <label class="sf-modal-label">Tipo</label>
            <input class="sf-modal-input" type="text" name="type" required placeholder="Ex: Consulta" />
          </div>
          <div>
            <label class="sf-modal-label">Modalidade</label>
            <input class="sf-modal-input" type="text" name="modality" required placeholder="Ex: Presencial" />
          </div>
        </div>
        <div class="sf-modal-grid-2">
          <div>
            <label class="sf-modal-label">Data</label>
            <input class="sf-modal-input" type="date" name="date" required min="${today}" value="${today}" />
          </div>
          <div>
            <label class="sf-modal-label">Hora</label>
            <input class="sf-modal-input" type="time" name="hour" required />
          </div>
        </div>
        <p class="sf-modal-error" id="sf-wa-modal-error"></p>
        <div class="sf-modal-actions">
          <button type="button" class="sf-modal-cancel">Fechar</button>
          <button type="submit" class="sf-modal-submit">Criar agendamento</button>
        </div>
      </form>
    `, 'Agenda');

    wireOpportunityCombo(overlay);
    overlay.querySelector('#sf-wa-modal-form').addEventListener('submit', handleSchedulingSubmit);

    // Profissional logado é sempre auto-atribuído no servidor (RN-022) — esconde
    // o campo pra não sugerir uma escolha que vai ser ignorada.
    if (currentUserRole === 'PROFISSIONAL') {
      overlay.querySelector('#sf-wa-modal-professional-field').classList.add('sf-hidden-el');
    } else {
      loadProfessionalsIntoSelect(overlay.querySelector('#sf-wa-modal-professional-field .sf-select'));
    }
  }

  // Markup de um dropdown customizado. Substitui o <select> nativo, cuja lista o
  // Chrome (Windows) pinta com o tema escuro do SO quando o WhatsApp está em dark
  // mode — fundo preto, texto ilegível. O valor trafega por um <input hidden> de
  // mesmo `name`, então os handlers de submit seguem lendo via FormData.
  function customSelectHTML({ name, disabled = false, placeholder = 'Selecione...' } = {}) {
    return `
      <div class="sf-select">
        <input type="hidden" name="${name}" value="" />
        <button type="button" class="sf-modal-input sf-select-trigger"${disabled ? ' disabled' : ''}>
          <span class="sf-select-value sf-select-placeholder">${escHtml(placeholder)}</span>
          <svg class="sf-select-caret" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <div class="sf-select-menu sf-hidden-el"></div>
      </div>
    `;
  }

  // Popula e liga o dropdown (recebe o container `.sf-select`). `options` é uma
  // lista [{ id, name }]; `value` marca a seleção inicial (id vazio = placeholder).
  function wireCustomSelect(widget, options, { value = '', onChange = null } = {}) {
    if (!widget) return;
    const hidden = widget.querySelector('input[type="hidden"]');
    const trigger = widget.querySelector('.sf-select-trigger');
    const valueEl = widget.querySelector('.sf-select-value');
    const menu = widget.querySelector('.sf-select-menu');

    const closeMenu = () => menu.classList.add('sf-hidden-el');
    const openMenu = () => {
      if (!trigger.disabled && menu.children.length) menu.classList.remove('sf-hidden-el');
    };

    // Fecha ao clicar fora; a própria checagem se auto-remove quando o modal sai.
    const onDocClick = (e) => {
      if (!widget.isConnected) { document.removeEventListener('click', onDocClick, true); return; }
      if (!widget.contains(e.target)) closeMenu();
    };
    document.addEventListener('click', onDocClick, true);

    trigger.addEventListener('click', () => {
      menu.classList.contains('sf-hidden-el') ? openMenu() : closeMenu();
    });

    menu.innerHTML = options.map(o => `
      <button type="button" class="sf-select-item" data-value="${escHtml(o.id)}">${escHtml(o.name)}</button>
    `).join('');

    const setValue = (val) => {
      const opt = options.find(o => String(o.id) === String(val)) || options[0];
      if (!opt) return;
      hidden.value = opt.id;
      valueEl.textContent = opt.name;
      valueEl.classList.toggle('sf-select-placeholder', !opt.id);
      menu.querySelectorAll('.sf-select-item').forEach(it =>
        it.classList.toggle('sf-select-item-active', it.getAttribute('data-value') === String(opt.id)));
    };

    menu.querySelectorAll('.sf-select-item').forEach(it => {
      it.addEventListener('click', () => {
        const val = it.getAttribute('data-value');
        setValue(val);
        closeMenu();
        // Só no clique: a seleção inicial (`setValue(value)` abaixo) não dispara
        // onChange, pra não sobrescrever campo já preenchido ao montar o modal.
        if (onChange) onChange(hidden.value);
      });
    });

    setValue(value);
  }

  // Busca os profissionais e monta o dropdown de responsável (assíncrono).
  function loadProfessionalsIntoSelect(widget, { includeEmptyOption = false, preselect = null } = {}) {
    if (!widget) return;
    const valueEl = widget.querySelector('.sf-select-value');

    chrome.runtime.sendMessage({ type: 'GET_PROFESSIONALS' }, (result) => {
      if (!widget.isConnected) return; // modal já fechado quando a resposta chegou

      if (!result || !result.ok) { valueEl.textContent = 'Erro ao carregar profissionais'; return; }
      const list = result.professionals || [];
      if (!list.length) { valueEl.textContent = 'Nenhum profissional encontrado'; return; }

      const firstLabel = includeEmptyOption ? 'Sem responsável' : 'Selecione...';
      const options = [{ id: '', name: firstLabel }, ...list];

      // Pré-seleciona o responsável indicado (edição) ou, na falta dele, o usuário logado.
      const wanted = preselect || currentUserId;
      const value = (wanted && list.some(p => String(p.id) === String(wanted))) ? wanted : '';
      wireCustomSelect(widget, options, { value });
    });
  }

  function handleSchedulingSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const errorEl = form.querySelector('#sf-wa-modal-error');
    errorEl.textContent = '';

    const fd = new FormData(form);
    const opportunityId = fd.get('opportunity_id');
    const date = fd.get('date');
    const hour = fd.get('hour');
    const type = (fd.get('type') || '').trim();
    const modality = (fd.get('modality') || '').trim();
    const responsibleUser = currentUserRole === 'PROFISSIONAL'
      ? currentUserId
      : fd.get('responsible_user');

    if (!opportunityId) {
      errorEl.textContent = 'Escolha o paciente/oportunidade.';
      return;
    }
    if (!date || !hour || !type || !modality || !responsibleUser) {
      errorEl.textContent = 'Preencha todos os campos.';
      return;
    }

    const submitBtn = form.querySelector('.sf-modal-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Criando...';

    chrome.runtime.sendMessage({
      type: 'CREATE_SCHEDULING',
      fields: {
        date, hour, type, modality,
        opportunity_id: opportunityId,
        responsible_user: responsibleUser,
      },
    }, (result) => {
      if (!form.isConnected) return; // modal fechado enquanto a chamada rodava

      if (!result || !result.ok) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Criar agendamento';
        errorEl.textContent = (result && result.error) || 'Erro ao criar agendamento.';
        return;
      }

      closeModal();
      fetchAgendaToday();
    });
  }

  // ─── Modal: Novo Acompanhamento ────────────────────────────────────────

  function openActivityModal() {
    const today = new Date().toISOString().slice(0, 10);
    const overlay = openModal('Novo Acompanhamento', '', `
      <form id="sf-wa-modal-form" class="sf-modal-body">
        <label class="sf-modal-label">Título</label>
        <input class="sf-modal-input" type="text" name="title" required placeholder="Ex: Confirmar retorno" />
        <label class="sf-modal-label">Data</label>
        <input class="sf-modal-input" type="date" name="due_date" required min="${today}" value="${today}" />
        <label class="sf-modal-label">Hora (opcional)</label>
        <input class="sf-modal-input" type="time" name="due_hour" />
        <label class="sf-modal-label">Prioridade</label>
        ${customSelectHTML({ name: 'priority' })}
        ${currentUserRole === 'PROFISSIONAL' ? '' : `
          <label class="sf-modal-label">Responsável (opcional)</label>
          ${customSelectHTML({ name: 'responsible_user', placeholder: 'Carregando...' })}
        `}
        <label class="sf-modal-label">Descrição (opcional)</label>
        <textarea class="sf-modal-input sf-modal-textarea" name="description" rows="3"></textarea>
        ${opportunityFieldHTML()}
        <p class="sf-modal-error" id="sf-wa-modal-error"></p>
        <div class="sf-modal-actions">
          <button type="button" class="sf-modal-cancel">Cancelar</button>
          <button type="submit" class="sf-modal-submit">Criar acompanhamento</button>
        </div>
      </form>
    `, 'Acompanhamentos');

    wireOpportunityCombo(overlay);
    overlay.querySelector('#sf-wa-modal-form').addEventListener('submit', handleActivitySubmit);

    wireCustomSelect(overlay.querySelector('input[name="priority"]').closest('.sf-select'), [
      { id: 'MEDIA', name: 'Média' },
      { id: 'ALTA', name: 'Alta' },
      { id: 'BAIXA', name: 'Baixa' },
    ], { value: 'MEDIA' });

    const respHidden = overlay.querySelector('input[name="responsible_user"]');
    if (respHidden) loadProfessionalsIntoSelect(respHidden.closest('.sf-select'), { includeEmptyOption: true });
  }

  function handleActivitySubmit(e) {
    e.preventDefault();
    const form = e.target;
    const errorEl = form.querySelector('#sf-wa-modal-error');
    errorEl.textContent = '';

    const fd = new FormData(form);
    const opportunityId = fd.get('opportunity_id');
    const title = (fd.get('title') || '').trim();
    const dueDate = fd.get('due_date');
    const dueHour = fd.get('due_hour') || '';
    const priority = fd.get('priority') || 'MEDIA';
    const responsibleUser = currentUserRole === 'PROFISSIONAL' ? '' : (fd.get('responsible_user') || '');
    const description = (fd.get('description') || '').trim();

    if (!opportunityId) {
      errorEl.textContent = 'Escolha o paciente/oportunidade.';
      return;
    }
    if (!title || !dueDate) {
      errorEl.textContent = 'Preencha título e data.';
      return;
    }

    const submitBtn = form.querySelector('.sf-modal-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Criando...';

    chrome.runtime.sendMessage({
      type: 'CREATE_ACTIVITY',
      fields: {
        title, due_date: dueDate, due_hour: dueHour, priority,
        responsible_user: responsibleUser,
        opportunity_id: opportunityId,
        description,
      },
    }, (result) => {
      if (!form.isConnected) return;

      if (!result || !result.ok) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Criar acompanhamento';
        errorEl.textContent = (result && result.error) || 'Erro ao criar acompanhamento.';
        return;
      }

      closeModal();
      fetchFollowUpsToday();
    });
  }

  // ─── Modal: Nova Atividade ──────────────────────────────────────────────

  function openEventModal() {
    const today = new Date().toISOString().slice(0, 10);
    const overlay = openModal('Nova Atividade', '', `
      <form id="sf-wa-modal-form" class="sf-modal-body">
        <label class="sf-modal-label">Tipo</label>
        <input class="sf-modal-input" type="text" name="type" required placeholder="Ex: Anotação, Retorno" />
        <label class="sf-modal-label">Data</label>
        <input class="sf-modal-input" type="date" name="date" required value="${today}" />
        <label class="sf-modal-label">Hora (opcional)</label>
        <input class="sf-modal-input" type="time" name="hour" />
        <label class="sf-modal-label">Descrição (opcional)</label>
        <textarea class="sf-modal-input sf-modal-textarea" name="description" rows="3"></textarea>
        ${opportunityFieldHTML()}
        <p class="sf-modal-error" id="sf-wa-modal-error"></p>
        <div class="sf-modal-actions">
          <button type="button" class="sf-modal-cancel">Cancelar</button>
          <button type="submit" class="sf-modal-submit">Criar atividade</button>
        </div>
      </form>
    `, 'Prontuário');

    wireOpportunityCombo(overlay);
    overlay.querySelector('#sf-wa-modal-form').addEventListener('submit', handleEventSubmit);
  }

  function handleEventSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const errorEl = form.querySelector('#sf-wa-modal-error');
    errorEl.textContent = '';

    const fd = new FormData(form);
    const opportunityId = fd.get('opportunity_id');
    const type = (fd.get('type') || '').trim();
    const date = fd.get('date');
    const hour = fd.get('hour') || '';
    const description = (fd.get('description') || '').trim();

    if (!opportunityId) {
      errorEl.textContent = 'Escolha o paciente/oportunidade.';
      return;
    }
    if (!type || !date) {
      errorEl.textContent = 'Preencha tipo e data.';
      return;
    }

    const submitBtn = form.querySelector('.sf-modal-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Criando...';

    chrome.runtime.sendMessage({
      type: 'CREATE_EVENT',
      fields: {
        type, date, hour,
        opportunity_id: opportunityId,
        description,
      },
    }, (result) => {
      if (!form.isConnected) return;

      if (!result || !result.ok) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Criar atividade';
        errorEl.textContent = (result && result.error) || 'Erro ao criar atividade.';
        return;
      }

      closeModal();
      // Histórico da oportunidade atual já visível no painel — recarrega.
      if (currentContact.name) fetchCRMData(currentContact.name);
    });
  }

  // ─── Atalhos "Agenda do Dia" / "Acompanhamentos do Dia" ───────────────────

  // Sem polling: cada painel só busca dado quando o usuário clica pra abrir.
  function toggleAgendaToday() {
    const panel = sidebar.querySelector('#sf-wa-agenda-today');
    const willOpen = panel.classList.contains('sf-hidden-el');
    panel.classList.toggle('sf-hidden-el', !willOpen);
    sidebar.querySelector('#sf-wa-agenda-today-btn').classList.toggle('sf-active', willOpen);
    if (willOpen) fetchAgendaToday();
  }

  function fetchAgendaToday() {
    chrome.runtime.sendMessage({ type: 'GET_AGENDA_TODAY' }, (result) => {
      lastAgendaResult = result;
      renderAgendaToday(result);
    });
  }

  function renderAgendaToday(result) {
    const countEl = sidebar.querySelector('#sf-wa-agenda-today-count');
    const panel = sidebar.querySelector('#sf-wa-agenda-today');
    if (!countEl || !panel) return;

    if (!result || !result.ok) {
      countEl.classList.add('sf-hidden-el');
      panel.innerHTML = `<span class="sf-field-value sf-empty">Erro ao carregar a agenda do dia.</span>`;
      return;
    }

    // Agenda do Dia é a lista geral da clínica (todos os agendamentos de hoje do
    // tenant), não só da oportunidade aberta — mesmo critério dos Acompanhamentos.
    const items = result.agenda || [];
    lastAgendaRendered = items;
    countEl.textContent = String(items.length);
    countEl.classList.toggle('sf-hidden-el', items.length === 0);

    if (!items.length) {
      panel.innerHTML = `<span class="sf-field-value sf-empty">Nenhum agendamento hoje.</span>`;
      return;
    }

    panel.innerHTML = `<div class="sf-today-list">${items.map((i, idx) => `
      <div class="sf-today-item sf-today-item-clickable" data-idx="${idx}">
        <span class="sf-today-time">${escHtml((i.hour || '').slice(0, 5))}</span>
        <div class="sf-today-info">
          <span class="sf-today-title">${escHtml(i.opportunityName || 'Compromisso')}</span>
          <span class="sf-today-sub">${escHtml(i.type || '')}${i.modality ? ' · ' + escHtml(i.modality) : ''}</span>
        </div>
        ${i.status ? schedulingStatusBadge(i) : ''}
      </div>`).join('')}</div>`;
  }

  function handleAgendaItemClick(e) {
    const el = e.target.closest('.sf-today-item-clickable');
    if (!el) return;
    const idx = Number(el.getAttribute('data-idx'));
    const item = lastAgendaRendered[idx];
    if (item) openAgendaDetailModal(item);
  }

  // Clicar num item da Agenda do Dia abre o mesmo modal de "Editar agendamento"
  // do Front-End (SchedulingModal em modo edição): edita data/hora/tipo/modalidade/
  // responsável (UPDATE_SCHEDULING) ou cancela o atendimento (CANCEL_SCHEDULING).
  // Espelha `fmtBRL` (lib/account/format) e `paymentPillInfo` (lib/pagamentos/format)
  // do Front-End — o card "Valor do atendimento" usa os mesmos rótulos/cores.
  function fmtBRL(v) {
    if (v == null) return '—';
    return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function paymentPillInfo(totalAmount, amountPaid) {
    if (!totalAmount || totalAmount <= 0) return null; // sem valor definido → não polui a UI
    const paid = amountPaid || 0;
    const kind = paid <= 0 ? 'pending' : paid >= totalAmount ? 'paid' : 'partial';
    const META = {
      pending: { label: 'Pendente', bg: 'rgba(148, 163, 184, .18)', color: '#64748b' },
      partial: { label: 'Pagamento Parcial', bg: 'rgba(245, 158, 11, .16)', color: '#b45309' },
      paid: { label: 'Pago', bg: 'rgba(22, 163, 74, .14)', color: '#15803d' },
    };
    return { kind, ...META[kind] };
  }

  // ─── Status derivado de agendamento ──────────────────────────────────────
  // O banco guarda o status cru (ex.: "AGENDADO" mesmo após o horário passar).
  // Aqui replicamos a derivação do Front-End (Calendar.tsx/agendamentos): o
  // horário já passou (início + 60min) sem estar concluído/cancelado → "perdido"
  // (Não compareceu). DEFAULT_DURATION_MIN = 60.
  function isPastScheduling(date, hour) {
    const d = date || new Date().toISOString().slice(0, 10);
    const hh = (hour || '00:00').slice(0, 5);
    const dt = new Date(`${d}T${hh}:00`);
    if (isNaN(dt.getTime())) return false;
    dt.setMinutes(dt.getMinutes() + 60);
    return dt.getTime() < Date.now();
  }

  function schedulingStatusKind(item) {
    const s = (item.status || '').toLowerCase();
    if (/cancel/.test(s)) return 'cancelado';
    if (/conclu|realiz|finaliz|atendid|compareceu/.test(s)) return 'concluido';
    if (isPastScheduling(item.date, item.hour)) return 'perdido';
    if (/remarc/.test(s)) return 'remarcado';
    if (/agend|marcad|confirm/.test(s)) return 'agendado';
    return 'outro';
  }

  const SCHED_STATUS_LABEL = {
    agendado: 'Agendado', remarcado: 'Remarcado', concluido: 'Concluído',
    cancelado: 'Cancelado', perdido: 'Não compareceu',
  };

  function schedulingStatusLabel(kind, item) {
    if (SCHED_STATUS_LABEL[kind]) return SCHED_STATUS_LABEL[kind];
    const t = (item.status || '').trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : '';
  }

  function schedulingStatusBadge(item) {
    const kind = schedulingStatusKind(item);
    return `<span class="sf-status-badge sf-sched-${kind}">${escHtml(schedulingStatusLabel(kind, item))}</span>`;
  }

  function openAgendaDetailModal(item) {
    const today = new Date().toISOString().slice(0, 10);
    const oppName = item.opportunityName || (currentOpportunity && currentOpportunity.name) || '—';
    const isProfessional = currentUserRole === 'PROFISSIONAL';

    const kind = schedulingStatusKind(item);
    const isCanceled = kind === 'cancelado';
    const isCompleted = kind === 'concluido';
    const needsRestore = kind === 'perdido';
    const viewOnly = isCanceled || isCompleted; // cancelado/concluído: só informativo

    // Restauração força uma nova data futura (hoje) e hora em branco; view-only e
    // edição normal mantêm a data/hora do registro.
    const dateVal = needsRestore ? today : (item.date || today).slice(0, 10);
    const hourVal = needsRestore ? '' : (item.hour || '').slice(0, 5);
    const minDate = needsRestore ? today : (dateVal < today ? dateVal : today);
    const dis = viewOnly ? ' disabled' : '';

    const NOTE = {
      cancelado: 'Este agendamento foi cancelado — nenhuma ação disponível.',
      concluido: 'Este atendimento já foi concluído.',
      perdido: 'O horário passou sem atendimento. Escolha uma nova data e hora para remarcar.',
    };
    const statusNote = NOTE[kind]
      ? `<div class="sf-agenda-status-note sf-agenda-status-note-${kind}">${escHtml(NOTE[kind])}</div>`
      : '';

    const payInfo = paymentPillInfo(item.totalAmount, item.amountPaid);
    const paymentCard = payInfo ? `
      <div class="sf-agenda-payment-card">
        <div class="sf-agenda-payment-row">
          <span class="sf-agenda-payment-label">Valor do atendimento</span>
          <div class="sf-agenda-payment-value-wrap">
            <span class="sf-agenda-payment-value">${escHtml(fmtBRL(item.totalAmount))}</span>
            <span class="sf-agenda-payment-pill" style="background:${payInfo.bg};color:${payInfo.color};">${escHtml(payInfo.label)}</span>
          </div>
        </div>
        <button type="button" class="sf-agenda-payment-link" id="sf-wa-agenda-payment-link">Gerenciar pagamento ↗</button>
      </div>` : '';

    const title = viewOnly ? 'Detalhes do agendamento' : needsRestore ? 'Remarcar agendamento' : 'Editar agendamento';

    const overlay = openModal(title, '', `
      <form id="sf-wa-agenda-edit-form" class="sf-modal-body">
        ${statusNote}
        ${paymentCard}
        <label class="sf-modal-label">Oportunidade</label>
        <div class="sf-modal-input sf-modal-input-readonly">${escHtml(oppName)}</div>

        <div id="sf-wa-agenda-professional-field">
          <label class="sf-modal-label">Profissional responsável</label>
          ${customSelectHTML({ name: 'responsible_user', disabled: viewOnly, placeholder: 'Carregando...' })}
        </div>

        <div class="sf-modal-grid-2">
          <div>
            <label class="sf-modal-label">Tipo</label>
            <input class="sf-modal-input" type="text" name="type" required value="${escHtml(item.type || '')}" placeholder="Ex: Consulta"${dis} />
          </div>
          <div>
            <label class="sf-modal-label">Modalidade</label>
            <input class="sf-modal-input" type="text" name="modality" required value="${escHtml(item.modality || '')}" placeholder="Ex: Presencial"${dis} />
          </div>
        </div>

        <div class="sf-modal-grid-2">
          <div>
            <label class="sf-modal-label">Data</label>
            <input class="sf-modal-input" type="date" name="date" required min="${minDate}" value="${dateVal}"${dis} />
          </div>
          <div>
            <label class="sf-modal-label">Hora</label>
            <input class="sf-modal-input" type="time" name="hour" required value="${escHtml(hourVal)}"${dis} />
          </div>
        </div>

        <p class="sf-modal-error" id="sf-wa-agenda-error"></p>

        <div class="sf-agenda-edit-footer" id="sf-wa-agenda-footer"></div>
      </form>
    `, 'Agenda');

    const form = overlay.querySelector('#sf-wa-agenda-edit-form');
    if (!viewOnly) form.addEventListener('submit', (e) => handleAgendaEditSubmit(e, item, needsRestore));

    const payLink = overlay.querySelector('#sf-wa-agenda-payment-link');
    if (payLink) {
      payLink.addEventListener('click', () => {
        if (appBase) window.open(`${appBase}/gestao-pagamentos?scheduling=${item.id}`, '_blank', 'noopener');
        closeModal();
      });
    }

    const profField = overlay.querySelector('#sf-wa-agenda-professional-field');
    if (isProfessional) {
      // PROFISSIONAL só agenda para si — o servidor força o responsável (RN-022).
      profField.classList.add('sf-hidden-el');
    } else {
      loadProfessionalsIntoSelect(profField.querySelector('.sf-select'), { preselect: item.responsibleUser });
    }

    rebuildAgendaFooter(overlay, item, { viewOnly, needsRestore });
  }

  // Rodapé do modal, conforme o status:
  //  • view-only (cancelado/concluído): só "Fechar";
  //  • restauração (perdido): só "Restaurar";
  //  • normal: "Cancelar atendimento" (esquerda) + "Salvar".
  function rebuildAgendaFooter(overlay, item, mode) {
    const footer = overlay.querySelector('#sf-wa-agenda-footer');
    if (!footer) return;
    const { viewOnly, needsRestore } = mode || {};

    if (viewOnly) {
      footer.innerHTML = `<button type="button" class="sf-modal-cancel sf-agenda-close-btn">Fechar</button>`;
      footer.querySelector('.sf-agenda-close-btn').addEventListener('click', () => closeModal());
      return;
    }

    if (needsRestore) {
      footer.innerHTML = `<span></span><button type="submit" class="sf-modal-submit sf-agenda-save-btn">Restaurar</button>`;
      return;
    }

    footer.innerHTML = `
      <button type="button" class="sf-agenda-cancel-appt" id="sf-wa-agenda-cancel-btn">${banSVG()} Cancelar atendimento</button>
      <button type="submit" class="sf-modal-submit sf-agenda-save-btn">Salvar</button>`;
    footer.querySelector('#sf-wa-agenda-cancel-btn')
      .addEventListener('click', () => showAgendaCancelConfirm(overlay, item));
  }

  function handleAgendaEditSubmit(e, item, restore) {
    e.preventDefault();
    const form = e.target;
    const errorEl = form.querySelector('#sf-wa-agenda-error');
    errorEl.textContent = '';

    const fd = new FormData(form);
    const date = fd.get('date');
    const hour = fd.get('hour');
    const type = (fd.get('type') || '').trim();
    const modality = (fd.get('modality') || '').trim();
    const responsibleUser = currentUserRole === 'PROFISSIONAL'
      ? currentUserId
      : fd.get('responsible_user');

    if (!date || !hour || !type || !modality || !responsibleUser) {
      errorEl.textContent = 'Preencha todos os campos.';
      return;
    }

    const saveLabel = restore ? 'Restaurar' : 'Salvar';
    const submitBtn = form.querySelector('.sf-agenda-save-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = restore ? 'Restaurando...' : 'Salvando...';

    chrome.runtime.sendMessage({
      type: 'UPDATE_SCHEDULING',
      fields: {
        id: item.id,
        date, hour, type, modality,
        opportunity_id: item.opportunityId,
        responsible_user: responsibleUser,
        ...(restore ? { restore: 1 } : {}),
      },
    }, (result) => {
      if (!form.isConnected) return; // modal fechado enquanto a chamada rodava

      if (!result || !result.ok) {
        submitBtn.disabled = false;
        submitBtn.textContent = saveLabel;
        errorEl.textContent = (result && result.error) || 'Erro ao salvar o agendamento.';
        return;
      }

      closeModal();
      fetchAgendaToday();
      if (currentContact.name) fetchCRMData(currentContact.name); // atualiza "Últimos Agendamentos"
    });
  }

  // Cancelamento com confirmação inline no próprio rodapé (sem modal aninhado).
  function showAgendaCancelConfirm(overlay, item) {
    const footer = overlay.querySelector('#sf-wa-agenda-footer');
    if (!footer) return;
    footer.innerHTML = `
      <span class="sf-agenda-cancel-confirm-text">Cancelar este atendimento?</span>
      <div class="sf-agenda-cancel-confirm-actions">
        <button type="button" class="sf-modal-cancel" id="sf-wa-agenda-cancel-back">Voltar</button>
        <button type="button" class="sf-agenda-cancel-confirm-btn" id="sf-wa-agenda-cancel-do">Sim, cancelar</button>
      </div>`;

    footer.querySelector('#sf-wa-agenda-cancel-back')
      .addEventListener('click', () => rebuildAgendaFooter(overlay, item));

    const doBtn = footer.querySelector('#sf-wa-agenda-cancel-do');
    doBtn.addEventListener('click', () => {
      doBtn.disabled = true;
      doBtn.textContent = 'Cancelando...';
      chrome.runtime.sendMessage({ type: 'CANCEL_SCHEDULING', id: item.id }, (result) => {
        if (!overlay.isConnected) return;
        if (!result || !result.ok) {
          doBtn.disabled = false;
          doBtn.textContent = 'Sim, cancelar';
          const errorEl = overlay.querySelector('#sf-wa-agenda-error');
          if (errorEl) errorEl.textContent = (result && result.error) || 'Erro ao cancelar o agendamento.';
          return;
        }
        closeModal();
        fetchAgendaToday();
        if (currentContact.name) fetchCRMData(currentContact.name); // atualiza "Últimos Agendamentos"
      });
    });
  }

  function toggleFollowUpsToday() {
    const panel = sidebar.querySelector('#sf-wa-followups-today');
    const willOpen = panel.classList.contains('sf-hidden-el');
    panel.classList.toggle('sf-hidden-el', !willOpen);
    sidebar.querySelector('#sf-wa-followups-today-btn').classList.toggle('sf-active', willOpen);
    if (willOpen) fetchFollowUpsToday();
  }

  function fetchFollowUpsToday() {
    chrome.runtime.sendMessage({ type: 'GET_FOLLOWUPS_TODAY' }, (result) => {
      lastFollowUpsResult = result;
      renderFollowUpsToday(result);
    });
  }

  function renderFollowUpsToday(result) {
    const countEl = sidebar.querySelector('#sf-wa-followups-today-count');
    const panel = sidebar.querySelector('#sf-wa-followups-today');
    if (!countEl || !panel) return;

    if (!result || !result.ok) {
      countEl.classList.add('sf-hidden-el');
      panel.innerHTML = `<span class="sf-field-value sf-empty">Erro ao carregar os acompanhamentos do dia.</span>`;
      return;
    }

    // Acompanhamentos do Dia é uma lista geral da clínica, não da oportunidade
    // aberta no momento (mesmo critério da Agenda do Dia).
    const items = result.followUps || [];
    countEl.textContent = String(items.length);
    countEl.classList.toggle('sf-hidden-el', items.length === 0);

    if (!items.length) {
      panel.innerHTML = `<span class="sf-field-value sf-empty">Nenhum acompanhamento hoje.</span>`;
      return;
    }

    panel.innerHTML = `<div class="sf-today-list">${items.map(i => `
      <div class="sf-today-item sf-today-item-clickable${i.overdue ? ' sf-today-item-overdue' : ''}" data-id="${i.id}">
        <span class="sf-today-time">${i.overdue ? escHtml(formatDateLabel(i.dueDate)) : escHtml((i.dueHour || '').slice(0, 5))}</span>
        <div class="sf-today-info">
          <span class="sf-today-title">${escHtml(i.title)}</span>
          <span class="sf-today-sub">${escHtml(i.opportunityName || 'Sem vínculo')}</span>
        </div>
        ${i.overdue ? '<span class="sf-today-overdue-tag">Atrasado</span>' : ''}
      </div>`).join('')}</div>`;
  }

  function handleFollowUpItemClick(e) {
    const el = e.target.closest('.sf-today-item-clickable');
    if (!el) return;
    const id = Number(el.getAttribute('data-id'));
    const items = (lastFollowUpsResult && lastFollowUpsResult.followUps) || [];
    const item = items.find(i => i.id === id);
    if (item) openFollowUpDetailModal(item);
  }

  const FOLLOWUP_PRIORITY_META = {
    ALTA: { label: 'Alta', color: '#e0245e', bg: 'rgba(224, 36, 94, .10)' },
    MEDIA: { label: 'Média', color: '#d97706', bg: 'rgba(217, 119, 6, .10)' },
    BAIXA: { label: 'Baixa', color: '#8c8c97', bg: 'rgba(140, 140, 151, .12)' },
  };

  function followUpPriorityMeta(priority) {
    return FOLLOWUP_PRIORITY_META[priority] || { label: priority || '—', color: '#8c8c97', bg: 'rgba(140, 140, 151, .12)' };
  }

  // Mesma regra do Front-End (`waLink` em lib/opportunities/format.ts): só
  // dígitos, prefixa DDI 55 quando o telefone vem sem ele.
  function waDigits(phone) {
    if (!phone) return null;
    let digits = EloMasks.onlyDigits(phone);
    if (!digits) return null;
    if (digits.length <= 11) digits = `55${digits}`;
    return digits;
  }

  // ─── Abrir a conversa NA PRÓPRIA ABA, sem recarregar ──────────────────────
  //
  // `wa.me`/`web.whatsapp.com/send` é navegação de verdade: seja em aba nova ou
  // na mesma aba, o WhatsApp Web inteiro sobe do zero (alguns segundos de tela
  // branca). Como o painel roda DENTRO da aba já logada, dá para trocar de
  // conversa pela própria interface — buscar o número na lista lateral, abrir o
  // primeiro resultado e escrever no campo de mensagem — sem nenhum reload.
  //
  // ⚠️ Isso depende do DOM do WhatsApp, que é ofuscado e muda a cada release
  // (mesma ressalva de docs/fase1-scraping-whatsapp.md). Por isso cada passo
  // tenta uma LISTA de seletores, tem timeout, e a falha devolve o motivo em
  // texto — que vai para o console (`[WA-PANEL]`) e para a tela. Nada de cair
  // em `wa.me`: aquele link sai do WhatsApp Web (passa pelo `api.whatsapp.com`,
  // com o pop-up "Abrir WhatsApp?") justamente o que não se quer aqui.
  //
  // O texto entra no campo mas NÃO é enviado — quem aperta Enter é a pessoa,
  // depois de ver na tela que é a conversa certa. Mensagem a cliente é
  // irreversível e a busca por número pode, em tese, abrir o contato errado.

  const CHAT_SWITCH_TIMEOUT_MS = 6000;
  // Tempo que o primeiro resultado precisa ficar parado para ser considerado
  // "a lista já filtrou" — sem isso o clique pega a lista velha, ainda não
  // reordenada pela busca.
  const CHAT_LIST_SETTLE_MS = 500;
  // Painel "Nova conversa" é animação local, não rede — se não abriu nesse
  // tempo, o botão clicado não era ele.
  const NEW_CHAT_PANEL_TIMEOUT_MS = 3000;
  // Quanto se espera o editor de mensagem exibir o que foi colado. É render
  // local (Lexical), não rede — passou disso, o `paste` não pegou mesmo.
  const EDITOR_SETTLE_TIMEOUT_MS = 1500;

  // Achar os campos por SELETOR não se sustenta: a busca já foi
  // `div[contenteditable][data-tab="3"]` e hoje pode ser um `<input>`, e o
  // container (`#side`) também some entre redesenhos. Então a procura é pelo
  // que o WhatsApp precisa manter estável para a própria acessibilidade — o
  // rótulo do campo — com a posição na tela como desempate.
  const SEARCH_LABEL_RE   = /pesquis|search|buscar/i;
  const COMPOSE_LABEL_RE  = /mensagem|message/i;
  const NEW_CHAT_LABEL_RE = /nova conversa|new chat|nueva conversaci/i;

  const TEXT_FIELD_SEL =
    'input[type="text"], input[type="search"], input:not([type]), textarea, [contenteditable="true"]';

  /** Elemento pertence ao painel do plugin (tudo nosso é prefixado `sf-wa`). */
  function isOurs(el) {
    for (let n = el; n; n = n.parentElement) {
      if (n.id && n.id.startsWith('sf-wa')) return true;
    }
    return false;
  }

  /**
   * Campos de texto visíveis do WhatsApp — os nossos ficam de fora. Visível é
   * medido por `getClientRects()`, não por `offsetParent`, que dá null em
   * qualquer elemento dentro de container `position: fixed`.
   */
  function textFields() {
    return Array.from(document.querySelectorAll(TEXT_FIELD_SEL))
      .filter(el => !isOurs(el) && el.getClientRects().length > 0);
  }

  /** Tudo que o WhatsApp usa para rotular o campo, junto — é o que identifica cada um. */
  function labelOf(el) {
    return [
      el.getAttribute('aria-label'),
      el.getAttribute('placeholder'),
      el.getAttribute('data-placeholder'),
      el.getAttribute('title'),
    ].filter(Boolean).join(' ');
  }

  function findSearchBox() {
    const fields = textFields();
    return fields.find(el => SEARCH_LABEL_RE.test(labelOf(el)))
        || fields.find(el => el.closest('#side'))
        || null;
  }

  function findComposeBox() {
    const fields = textFields().filter(el => !SEARCH_LABEL_RE.test(labelOf(el)));
    return fields.find(el => COMPOSE_LABEL_RE.test(labelOf(el)))
        || fields.find(el => el.closest('footer'))
        || fields.find(el => el.closest('#main'))
        || null;
  }

  /** Botão "Nova conversa" (o lápis no topo da lista). */
  function findNewChatButton() {
    return Array.from(document.querySelectorAll('button, [role="button"], [aria-label]'))
      .filter(el => !isOurs(el) && el.getClientRects().length > 0)
      .find(el => NEW_CHAT_LABEL_RE.test(labelOf(el))) || null;
  }

  /**
   * Linhas de lista VISÍVEIS dentro de `root`. A visibilidade não é detalhe:
   * com o painel "Nova conversa" aberto, a lista de conversas de trás continua
   * no DOM, e pegar uma linha dela abre a conversa errada.
   */
  function rowsIn(root) {
    if (!root) return [];
    for (const sel of ['[role="listitem"]', '[role="row"]', '[role="option"]', '[role="gridcell"]']) {
      const rows = Array.from(root.querySelectorAll(sel))
        .filter(el => !isOurs(el) && el.getClientRects().length > 0);
      if (rows.length) return rows;
    }
    return [];
  }

  /** Linhas da lista de conversas — de `scope`, senão de `#pane-side`, senão da página. */
  function chatRows(scope) {
    if (scope) return rowsIn(scope);
    const pane = rowsIn(document.querySelector('#pane-side'));
    return pane.length ? pane : rowsIn(document);
  }

  /**
   * Container do painel "Nova conversa": primeiro ancestral da busca do painel
   * que já tem linhas de resultado. É o escopo que separa os resultados da
   * busca da lista de conversas que ficou atrás do painel.
   */
  function panelScopeOf(searchEl) {
    for (let n = searchEl && searchEl.parentElement; n && n !== document.body; n = n.parentElement) {
      if (rowsIn(n).length) return n;
    }
    return null;
  }

  /** Texto do cabeçalho da conversa aberta ('' quando não há conversa aberta). */
  function openChatHeaderText() {
    const header = document.querySelector('#main header');
    return header ? (header.textContent || '').trim() : '';
  }

  /**
   * A conversa aberta é a do número? Só dá para afirmar quando o cabeçalho
   * mostra o número — contato salvo mostra o nome.
   */
  function headerMatchesDigits(digits) {
    const headerDigits = openChatHeaderText().replace(/\D/g, '');
    return !!headerDigits && headerDigits.includes(digits.slice(-8));
  }

  // Falhou: despeja no console o que existe na página, para ajustar a busca dos
  // campos sem precisar adivinhar de novo.
  function logChatDomSnapshot(reason) {
    console.warn('[WA-PANEL] Não abri a conversa:', reason, {
      side: !!document.querySelector('#side'),
      paneSide: !!document.querySelector('#pane-side'),
      main: !!document.querySelector('#main'),
      botaoNovaConversa: labelOf(findNewChatButton() || document.body) || null,
      conversaAberta: openChatHeaderText() || null,
      linhasDaLista: chatRows().length,
      campos: textFields().map(el => ({
        tag: el.tagName,
        type: el.getAttribute('type'),
        dataTab: el.getAttribute('data-tab'),
        role: el.getAttribute('role'),
        rotulo: labelOf(el),
        emSide: !!el.closest('#side'),
        emMain: !!el.closest('#main'),
        emFooter: !!el.closest('footer'),
      })),
    });
  }

  // O React do WhatsApp escuta a sequência inteira, e as versões novas ouvem
  // `pointerdown`/`pointerup` — mouse events sozinhos não trocam de conversa.
  // O alvo também importa: quem tem o handler é o elemento que está por cima no
  // centro da linha (`elementFromPoint`), não o `[role="listitem"]` de fora —
  // disparar no container errado é evento que não chega a handler nenhum.
  function fireClick(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const onTop = (rect.width && rect.height) ? document.elementFromPoint(x, y) : null;
    const hit = (onTop && el.contains(onTop)) ? onTop : el;

    const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 };
    const down = { ...base, buttons: 1 };
    const up = { ...base, buttons: 0 };
    const pointer = { pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1 };

    hit.dispatchEvent(new PointerEvent('pointerover', { ...down, ...pointer }));
    hit.dispatchEvent(new MouseEvent('mouseover', down));
    hit.dispatchEvent(new PointerEvent('pointerdown', { ...down, ...pointer }));
    hit.dispatchEvent(new MouseEvent('mousedown', down));
    if (typeof hit.focus === 'function') hit.focus();
    hit.dispatchEvent(new PointerEvent('pointerup', { ...up, ...pointer }));
    hit.dispatchEvent(new MouseEvent('mouseup', up));
    hit.dispatchEvent(new MouseEvent('click', up));
  }

  /**
   * Espera a conversa REALMENTE trocar depois do clique — cabeçalho com o
   * número, ou pelo menos diferente do que estava. Sem essa confirmação, um
   * clique que não pegou deixava o texto no campo da conversa que já estava
   * aberta: mensagem escrita para o contato errado.
   */
  function waitForChatSwitch(digits, headerBefore) {
    return waitFor(() => {
      const now = openChatHeaderText();
      if (!now) return null;
      if (headerMatchesDigits(digits)) return true;
      return now !== headerBefore ? true : null;
    });
  }

  function waitFor(check, timeoutMs = CHAT_SWITCH_TIMEOUT_MS) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const tick = () => {
        let found = null;
        try { found = check(); } catch (_) { found = null; }
        if (found) { resolve(found); return; }
        if (Date.now() - startedAt > timeoutMs) { resolve(null); return; }
        setTimeout(tick, 120);
      };
      tick();
    });
  }

  /**
   * Texto como aparece na TELA: `innerText` respeita <br> e blocos, então é ele
   * — não `textContent` — que mostra se as quebras de linha entraram.
   */
  function editorText(el) {
    return (el.innerText || el.textContent || '').replace(/\r/g, '').replace(/\u00a0/g, ' ');
  }

  // Comparação por letras e números só. Espaço fica de fora (o editor
  // normaliza), pontuação e emoji também: emoji virou imagem no editor do
  // WhatsApp e não aparece no `innerText`, o que faria a conferência falhar
  // num texto que na verdade entrou inteiro.
  const textKey = (s) => s.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();

  /**
   * Seleciona TODO o conteúdo do editor com Range/Selection. `el.focus()` não
   * cria caret dentro de um contenteditable controlado, e aí o
   * `execCommand('selectAll')` seleciona outra coisa (ou nada): o texto novo
   * entrava emendado no rascunho que o WhatsApp guardou da tentativa anterior —
   * a mensagem aparecia duas vezes, uma achatada e outra certa.
   */
  function selectAllIn(el) {
    const sel = window.getSelection();
    if (!sel) return false;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }

  /**
   * Esvazia o editor — inclusive o rascunho que já estava na conversa — e
   * confirma que ficou vazio. Sem a confirmação não dá para escrever: colar por
   * cima de rascunho é o que duplicava a mensagem.
   */
  function clearEditor(el) {
    for (let i = 0; i < 3 && editorText(el).trim(); i++) {
      el.focus();
      selectAllIn(el);
      document.execCommand('delete', false, null);
    }
    return !editorText(el).trim();
  }

  /**
   * Cola `text` no editor como um Ctrl+V. É o caminho que preserva as QUEBRAS
   * DE LINHA: o campo de mensagem é um contenteditable controlado (Lexical) e
   * `execCommand('insertText')` entrega o texto todo numa linha só — foi assim
   * que os parágrafos da campanha chegaram grudados. O `paste` sintético passa
   * pelo mesmo handler do Ctrl+V, que lê o `text/plain` respeitando os "\n".
   * Devolve `false` quando o editor não aceitou (aí o chamador tenta o resto).
   */
  function pasteInto(el, text) {
    try {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true, cancelable: true, clipboardData: data,
      }));
    } catch (_) {
      return false;
    }
    return true;
  }

  /**
   * Espera o editor MOSTRAR o texto. O campo de mensagem é um Lexical: ele
   * processa o `paste` num tick posterior, então conferir `innerText` no mesmo
   * instante do dispatch dava "não aceitou o texto" com a mensagem já na tela —
   * e ainda fazia a tentativa seguinte apagar o que tinha acabado de entrar.
   */
  function waitForEditorText(el, text) {
    const want = textKey(text);
    return waitFor(() => (textKey(editorText(el)) === want ? true : null), EDITOR_SETTLE_TIMEOUT_MS);
  }

  // `<input>` controlado por React ignora `el.value = x` — o valor precisa
  // passar pelo setter nativo para o React ver a mudança. Já no
  // `contenteditable` (editor da mensagem) escrever em `textContent` não é
  // registrado: vai por `paste` (preserva as quebras) e, se ele não pegar, por
  // `execCommand('insertText')`.
  async function typeInto(el, text) {
    el.focus();

    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value === text;
    }

    if (!text) return clearEditor(el);

    // Cada tentativa espera o editor assentar (`waitForEditorText`) antes de
    // desistir — conferir na hora é o que fazia a 1ª "falhar" e a 2ª apagar o
    // texto recém-colado.
    //
    // 1ª: substituir a seleção (conteúdo inteiro) pelo paste.
    selectAllIn(el);
    if (pasteInto(el, text) && await waitForEditorText(el, text)) return true;

    // 2ª: esvaziar de verdade e colar no campo vazio.
    if (clearEditor(el) && pasteInto(el, text) && await waitForEditorText(el, text)) return true;

    // 3ª: o editor ignorou o `paste`. `insertText` entrega o texto achatado
    // (sem as quebras), o que ainda é melhor que campo vazio.
    clearEditor(el);
    document.execCommand('insertText', false, text);

    // Gate final: o campo tem o texto e SÓ ele. `textKey` ignora espaços, então
    // quebra achatada passa — mas texto repetido (o bug da duplicação) não.
    return await waitForEditorText(el, text);
  }

  // Confere se a linha é mesmo do número procurado. Compara pelo FINAL dos
  // dígitos porque o WhatsApp exibe o número formatado e nem sempre com DDI.
  // Contato salvo mostra o nome, não o número — aí não dá para confirmar, e o
  // chamador cai na primeira linha da lista já filtrada.
  function rowMatchesDigits(row, digits) {
    const rowDigits = (row.textContent || '').replace(/\D/g, '');
    return !!rowDigits && rowDigits.includes(digits.slice(-8));
  }

  // Espera a lista de resultados parar de mudar (senão o clique pega a lista
  // velha, de antes da busca) e devolve a linha do número — ou a primeira.
  function waitForResultRow(digits, getScope) {
    let lastKey = null;
    let stableSince = Date.now();
    return waitFor(() => {
      // Com escopo (painel "Nova conversa"), enquanto ele não tiver resultado a
      // espera continua — nunca cai na lista de conversas que ficou atrás.
      let scope = null;
      if (getScope) {
        scope = getScope();
        if (!scope) { lastKey = null; return null; }
      }
      const rows = chatRows(scope);
      if (!rows.length) { lastKey = null; return null; }

      const key = rows.map(r => r.textContent || '').join('|');
      if (key !== lastKey) { lastKey = key; stableSince = Date.now(); return null; }
      if (Date.now() - stableSince < CHAT_LIST_SETTLE_MS) return null;

      return rows.find(r => rowMatchesDigits(r, digits)) || rows[0];
    });
  }

  /**
   * Abre o chat do número na aba atual e deixa `text` digitado no campo de
   * mensagem, sem enviar.
   *
   * Devolve `{ ok, chatOpened, reason, warning }`. `chatOpened` é separado de
   * `ok` de propósito: é ele que diz se a conversa NA TELA é a do número — a
   * única condição para vincular o lead a ela. Texto que entrou diferente do
   * esperado é `warning`, não falha: a pessoa lê a mensagem antes de apertar
   * Enter, e travar aí só a obrigava a copiar e colar à mão.
   */
  async function openChatInPlace(phone, text) {
    const fail = (reason, chatOpened = false) => { logChatDomSnapshot(reason); return { ok: false, chatOpened, reason }; };

    const digits = waDigits(phone);
    if (!digits) return fail('telefone do lead está vazio');

    const opened = await openChatByNumber(digits);
    if (opened !== true) return fail(opened);

    const compose = await waitFor(() => findComposeBox());
    if (!compose) return fail('a conversa abriu, mas não achei o campo de mensagem', true);

    if (await typeInto(compose, text)) return { ok: true, chatOpened: true };

    // Campo VAZIO é falha de verdade; campo escrito é divergência (quebra de
    // linha achatada, texto sobrando de um rascunho) — vai como aviso.
    if (!editorText(compose).trim()) return fail('o campo de mensagem não aceitou o texto', true);

    return {
      ok: true,
      chatOpened: true,
      warning: 'confira a mensagem no campo — ela pode ter saído diferente da que estava na ficha',
    };
  }

  /**
   * Leva a tela até a conversa do número. Caminho principal é o painel "Nova
   * conversa" do WhatsApp, porque ele aceita QUALQUER número — inclusive lead
   * vindo de scraping, que nunca conversou com a clínica e não está nos
   * contatos. A busca da lista lateral só enxerga conversa que já existe, então
   * fica de reserva, para quando o botão "Nova conversa" não for encontrado.
   */
  async function openChatByNumber(digits) {
    // Conversa certa já aberta (cabeçalho com o número): nada a fazer.
    if (headerMatchesDigits(digits)) return true;

    const headerBefore = openChatHeaderText();
    const listSearch = findSearchBox();
    const newChatBtn = findNewChatButton();

    if (newChatBtn) {
      fireClick(newChatBtn);

      // O painel abre com uma caixa de busca própria ("Pesquisar nome ou
      // número"). Identifica-se por ser a que NÃO estava lá antes do clique — a
      // da lista continua no DOM e tem rótulo parecido.
      const panelSearch = await waitFor(
        () => textFields().find(el => el !== listSearch && SEARCH_LABEL_RE.test(labelOf(el))) || null,
        NEW_CHAT_PANEL_TIMEOUT_MS,
      );

      if (panelSearch) {
        if (!(await typeInto(panelSearch, digits))) return 'a busca de "Nova conversa" não aceitou o número';
        const row = await waitForResultRow(digits, () => panelScopeOf(panelSearch));
        if (!row) return `o WhatsApp não ofereceu conversa para ${digits} — confira se o número está certo`;
        fireClick(row);
        if (await waitForChatSwitch(digits, headerBefore)) return true;
        return `cliquei no resultado de ${digits} em "Nova conversa", mas a conversa não abriu`;
      }
    }

    if (!listSearch) return 'não achei nem o botão "Nova conversa" nem a caixa de busca';

    fireClick(listSearch);
    if (!(await typeInto(listSearch, digits))) return 'a caixa de busca não aceitou o número';

    const row = await waitForResultRow(digits);
    if (!row) {
      await typeInto(listSearch, ''); // desfaz o filtro antes de devolver a lista ao usuário
      return `nenhuma conversa encontrada para ${digits}`;
    }
    fireClick(row);
    if (await waitForChatSwitch(digits, headerBefore)) return true;
    return `cliquei na conversa de ${digits} na lista, mas ela não abriu`;
  }

  function openFollowUpDetailModal(item) {
    const meta = followUpPriorityMeta(item.priority);
    const msg = item.suggestionMessage;
    const canOpenChat = !!(msg && waDigits(item.phone));
    const opportunitySummary = item.opportunityId ? opportunitySummaryHTML({
      name: item.opportunityName,
      phone: item.phone,
      status: item.opportunityStatus,
      potential: item.opportunityPotential,
      source: item.opportunitySource,
      sourceLabel: item.opportunitySourceLabel,
    }) : '';

    const overlay = openModal(item.title, item.opportunityName || 'Sem vínculo', `
      <div class="sf-modal-body">
        ${opportunitySummary ? `<div class="sf-followup-opp-summary">${opportunitySummary}</div>` : ''}
        <div class="sf-followup-section-head">
          <span class="sf-modal-label sf-followup-label">Próxima Ação</span>
          <span class="sf-followup-priority-badge" style="color:${meta.color};background:${meta.bg};">${escHtml(meta.label)}</span>
        </div>
        <div class="sf-followup-action-box" style="border-left-color:${meta.color};">${escHtml(item.description || '—')}</div>
        ${msg ? `
          <span class="sf-modal-label sf-followup-label">Mensagem Sugerida</span>
          <div class="sf-followup-msg-box">
            <p class="sf-followup-msg-text">${escHtml(msg)}</p>
            <div class="sf-followup-msg-actions">
              <button type="button" class="sf-followup-copy-btn">Copiar mensagem</button>
              ${canOpenChat ? `<button type="button" class="sf-followup-wa-btn">Enviar no WhatsApp</button>` : ''}
            </div>
          </div>
        ` : ''}
      </div>
    `);

    const copyBtn = overlay.querySelector('.sf-followup-copy-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(msg).then(() => {
          copyBtn.textContent = 'Copiado!';
          setTimeout(() => { if (copyBtn.isConnected) copyBtn.textContent = 'Copiar mensagem'; }, 2000);
        });
      });
    }

    const waBtn = overlay.querySelector('.sf-followup-wa-btn');
    if (waBtn) {
      // Abre a conversa na própria aba com o texto no campo (`openChatInPlace`)
      // e registra o envio como a ficha do lead faz (REGISTER_WHATSAPP_SEND:
      // avança a cadência/funil, atribui o lead e vincula a conversa). Só
      // concluir a tarefa (COMPLETE_ACTIVITY) deixava o prospect parado na
      // etapa e sem próxima ação — o "Contato 3" nunca era criado. A conclusão
      // continua depois, para o acompanhamento que não é o toque da cadência
      // (oportunidade comercial ou tarefa avulsa); no toque, já veio concluído.
      waBtn.addEventListener('click', async () => {
        waBtn.disabled = true;
        waBtn.textContent = 'Abrindo conversa...';

        const chat = await openChatInPlace(item.phone, msg);
        if (!chat.ok) {
          // Não abriu a conversa: o acompanhamento NÃO é concluído — marcar
          // como feito aqui esconderia da lista uma mensagem que ninguém mandou.
          // (o motivo já foi para o console em `openChatInPlace`)
          waBtn.disabled = false;
          waBtn.textContent = 'Tentar de novo';
          waBtn.title = `Não deu para abrir a conversa aqui: ${chat.reason}`;
          return;
        }

        waBtn.classList.add('sf-followup-wa-btn-sent');
        waBtn.textContent = 'Atualizando o CRM...';

        const sent = item.opportunityId
          ? await registerLeadSend({ id: item.opportunityId, phone: item.phone }, null, true)
          : null;
        const completed = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: 'COMPLETE_ACTIVITY', id: item.id }, resolve);
        });

        closeModal();
        fetchFollowUpsToday();
        if (sent) {
          const summary = leadSendSummary(chat, sent);
          updateTimestamp(summary);
          showFlash(summary, sent.ok ? 'ok' : 'error');
          if (sent.notes && sent.notes.length) console.warn('[WA-PANEL] Envio registrado com ressalvas:', sent.notes);
        } else if (!completed || !completed.ok) {
          showFlash(`Acompanhamento NÃO concluído: ${(completed && completed.error) || 'falha ao falar com a API'}`, 'error');
        }
      });
    }
  }

  // ─── Rail de ícones (navegação rápida dentro do painel) ───────────────────

  function handleRailClick(btn) {
    const expand = btn.getAttribute('data-expand');
    if (expand === 'agenda') {
      const panel = sidebar.querySelector('#sf-wa-agenda-today');
      if (panel && panel.classList.contains('sf-hidden-el')) toggleAgendaToday();
    } else if (expand === 'followups') {
      const panel = sidebar.querySelector('#sf-wa-followups-today');
      if (panel && panel.classList.contains('sf-hidden-el')) toggleFollowUpsToday();
    }

    const targetId = btn.getAttribute('data-target');
    const target = sidebar.querySelector(`#${targetId}`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ─── Barra de oportunidade (cabeçalho fixo, sempre visível) ───────────────

  // Re-renderiza as listas "do dia" com o cache já em mãos — não espera o
  // próximo poll (até 30s) pra refletir a troca de contato/oportunidade.
  function refreshTodayShortcutsForCurrentOpportunity() {
    if (lastAgendaResult) renderAgendaToday(lastAgendaResult);
    if (lastFollowUpsResult) renderFollowUpsToday(lastFollowUpsResult);
  }

  function hideOpportunityBar() {
    const bar = sidebar.querySelector('#sf-wa-opportunity-bar');
    currentOpportunity = null;
    updateNewMenuAvailability();
    refreshTodayShortcutsForCurrentOpportunity();
    if (!bar) return;
    bar.classList.add('sf-hidden-el');
    bar.innerHTML = '';
  }

  // Resumo rápido (item 3 da spec): "Último atendimento" e "Próximo retorno"
  // são derivados dos próprios agendamentos que já vêm no lookup (sem precisar
  // de campo novo no backend). "Tratamento" é uma aproximação honesta — usa o
  // `type` do agendamento mais relevante, não é um campo dedicado de
  // tratamento (esse dado não existe hoje no payload).
  function computeQuickSummary(schedulings) {
    if (!schedulings || !schedulings.length) return null;

    const todayStr = new Date().toISOString().slice(0, 10);
    const sorted = schedulings.slice().sort((a, b) =>
      `${a.date || ''} ${a.hour || ''}`.localeCompare(`${b.date || ''} ${b.hour || ''}`));

    const past = sorted.filter(s => (s.date || '') <= todayStr);
    const future = sorted.filter(s => (s.date || '') > todayStr);
    const lastVisit = past.length ? past[past.length - 1] : null;
    const nextVisit = future.length ? future[0] : null;
    const treatmentSource = nextVisit || lastVisit;

    if (!lastVisit && !nextVisit) return null;
    return {
      lastVisit: lastVisit ? { date: lastVisit.date, hour: lastVisit.hour } : null,
      nextVisit: nextVisit ? { date: nextVisit.date, hour: nextVisit.hour } : null,
      treatment: treatmentSource ? (treatmentSource.type || null) : null,
    };
  }

  // Sugestão inteligente (item 9 da spec) — regra de negócio pura sobre datas
  // que já temos, SEM IA generativa: quanto tempo faz desde a última atividade
  // ou agendamento (o que for mais recente), e se o último evento parece ser
  // um tratamento (limpeza/consulta/procedimento) muito antigo, sugere retorno
  // preventivo em vez do aviso genérico de "sem contato".
  const TREATMENT_KEYWORD_RE = /tratamento|limpeza|consulta|procedimento|implante/i;

  function computeSuggestion(activities, schedulings) {
    const events = [...(activities || []), ...(schedulings || [])].filter(e => e.date);
    if (!events.length) return null;

    events.sort((a, b) => `${b.date} ${b.hour || ''}`.localeCompare(`${a.date} ${a.hour || ''}`));
    const last = events[0];
    const daysSince = Math.floor((Date.now() - new Date(`${last.date}T00:00:00`).getTime()) / 86400000);
    if (daysSince < 0) return null; // data futura (agendamento marcado) — nada a sugerir

    const isTreatmentEvent = TREATMENT_KEYWORD_RE.test(`${last.categoryLabel || ''} ${last.type || ''}`);

    if (isTreatmentEvent && daysSince >= 330) {
      const months = Math.round(daysSince / 30);
      const label = (last.categoryLabel || last.type || 'atendimento').toLowerCase();
      return { level: 'warn', emoji: '🟠', text: `Último ${label} há ${months} meses. Pode ser um bom momento para sugerir um retorno preventivo.` };
    }
    if (daysSince >= 15) {
      return { level: 'danger', emoji: '🔴', text: `Paciente está há ${daysSince} dias sem contato.` };
    }
    if (daysSince >= 7) {
      return { level: 'info', emoji: '🟢', text: `Última interação há ${daysSince} dias — pode ser um bom momento para retomar contato.` };
    }
    return null;
  }

  function suggestionBannerHTML(suggestion) {
    if (!suggestion) return '';
    return `
      <div class="sf-suggestion-banner sf-suggestion-${suggestion.level}">
        <span class="sf-suggestion-icon">${suggestion.emoji}</span>
        <span class="sf-suggestion-text">${escHtml(suggestion.text)}</span>
      </div>
    `;
  }

  // Cabeçalho de identificação da oportunidade (nome/status/potencial-ou-
  // cliente/telefone/origem/resumo rápido/sugestão) — reaproveitado pela barra
  // fixa do contato atual (`renderOpportunityBar`) e pelo modal de detalhe de
  // acompanhamento (esse último não tem `summary`/`suggestion`, já que não
  // carrega a lista de agendamentos/atividades daquela oportunidade).
  // "Convertido" (status === CLIENTE no banco) já fechou negócio: o campo de
  // potencial de conversão não faz mais sentido, então vira um rótulo "Cliente".
  function opportunitySummaryHTML(contact, summary = null, suggestion = null) {
    // Cliente = status "Convertido" (UI) / enum CLIENTE no banco. Comparação
    // normalizada (case-insensitive, aceita "Cliente"/"Convertido") pra não
    // depender da grafia exata que a API mandar.
    const statusNorm = (contact.status || '').trim().toLowerCase();
    const isClient = statusNorm === 'convertido' || statusNorm === 'cliente';
    return `
      <div class="sf-opp-bar-head">
        <span class="sf-opp-bar-avatar">${initials(contact.name)}</span>
        <div class="sf-opp-bar-id">
          <p class="sf-opp-bar-name">${escHtml(contact.name)}</p>
          ${contact.status ? `<span class="sf-status-badge sf-status-${slugify(contact.status)}">${escHtml(contact.status)}</span>` : ''}
        </div>
      </div>
      ${suggestionBannerHTML(suggestion)}
      <div class="sf-opp-bar-grid">
        <div class="sf-opp-bar-cell">
          <span class="sf-opp-bar-label">Telefone</span>
          <span class="sf-opp-bar-value sf-opp-bar-phone">${contact.phone ? escHtml(contact.phone) : '—'}</span>
        </div>
        <div class="sf-opp-bar-cell">
          <span class="sf-opp-bar-label">Origem</span>
          <span class="sf-opp-bar-origin">${originBadgeHTML(contact.source, contact.sourceLabel)}</span>
        </div>
        ${summary && summary.lastVisit ? `
        <div class="sf-opp-bar-cell">
          <span class="sf-opp-bar-label">Último atendimento</span>
          <span class="sf-opp-bar-value">${escHtml(formatDateLabel(summary.lastVisit.date))}</span>
        </div>` : ''}
        ${summary && summary.nextVisit ? `
        <div class="sf-opp-bar-cell">
          <span class="sf-opp-bar-label">Próximo retorno</span>
          <span class="sf-opp-bar-value">${escHtml(formatDateLabel(summary.nextVisit.date))}</span>
        </div>` : ''}
        ${summary && summary.treatment ? `
          <div class="sf-opp-bar-cell sf-opp-bar-cell-secondary">
            <span class="sf-opp-bar-label">Tratamento (aprox.)</span>
            <span class="sf-opp-bar-value">${escHtml(summary.treatment)}</span>
          </div>` : ''}
        ${isClient ? `
          <div class="sf-opp-bar-cell sf-opp-bar-cell-secondary">
            <span class="sf-opp-bar-label">Tipo</span>
            <span class="sf-opp-bar-value">Cliente</span>
          </div>` : contact.potential ? `
          <div class="sf-opp-bar-cell sf-opp-bar-cell-secondary">
            <span class="sf-opp-bar-label">Potencial</span>
            <div class="sf-opp-bar-potential-row">
              <div class="sf-potential-bar sf-potential-bar-sm"><div class="sf-potential-fill sf-potential-${slugify(contact.potential)}" style="width:${potentialPct(contact.potential)}%"></div></div>
              <span class="sf-opp-bar-value">${escHtml(contact.potential)}</span>
            </div>
          </div>` : ''}
      </div>
    `;
  }

  function renderOpportunityBar(contact, summary = null, suggestion = null) {
    const bar = sidebar.querySelector('#sf-wa-opportunity-bar');
    if (!bar || !contact) return;

    currentOpportunity = { id: contact.id, name: contact.name };
    updateNewMenuAvailability();
    refreshTodayShortcutsForCurrentOpportunity();

    bar.innerHTML = `${opportunitySummaryHTML(contact, summary, suggestion)}${renderOpportunityActions(contact)}`;
    bar.classList.remove('sf-hidden-el');
  }

  // Ícone de marca por origem (`opportunity.opportunity_source`) — porte
  // simplificado de `OriginBadge.tsx` do app principal para vanilla JS/SVG.
  const ORIGIN_META = {
    WHATSAPP:  { bg: 'var(--sf-wa)', icon: '<path d="M12.4 3.6A6.9 6.9 0 0 0 2.5 12l-.9 3.3 3.4-.9A6.9 6.9 0 1 0 12.4 3.6Z" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M5.3 5.7c.2-.4.4-.4.6-.4h.3c.15 0 .3 0 .4.35.15.3.45 1.1.5 1.2.05.1.08.2 0 .35-.08.15-.12.2-.25.35-.12.15-.25.25-.1.5.15.25.6 1 1.3 1.6.9.8 1.6 1.05 1.85 1.2.25.1.4.1.55-.05.15-.15.55-.65.7-.9.15-.25.3-.2.5-.12.2.08 1.2.6 1.4.7.2.1.35.15.4.25.05.1.05.5-.15 1-.2.45-1.05.9-1.45.95-.4.05-.85.05-1.35-.1a9 9 0 0 1-4-2.8 7.8 7.8 0 0 1-1.6-3.1c-.15-.5-.15-.95 0-1.25Z" fill="currentColor"/>' },
    INSTAGRAM: { bg: 'linear-gradient(45deg,#f9ce34,#ee2a7b,#6228d7)', icon: '<rect x="2" y="2" width="12" height="12" rx="4" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="11.5" cy="4.5" r="0.8" fill="currentColor"/>' },
    FACEBOOK:  { bg: '#1877F2', letter: 'f' },
    GOOGLE:    { bg: '#ffffff', border: true, letter: 'G', letterColor: 'var(--sf-blue)' },
    SITE:      { bg: 'var(--sf-blue)', icon: '<circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" stroke="currentColor" stroke-width="1.1" fill="none"/>' },
    TELEFONE:  { bg: '#0ea5e9', icon: '<path d="M4 3.2c.4-.4.9-.4 1.3 0l1 1.1c.4.4.4.9-.05 1.35l-.65.65c.35.9 1.7 2.25 2.6 2.6l.65-.65c.45-.45.95-.45 1.35-.05l1.1 1c.45.45.45.9 0 1.35l-.8.8c-.45.45-1.15.6-1.8.35-1.8-.7-4.2-3.1-4.9-4.9-.25-.65-.1-1.35.35-1.8l.8-.8Z" fill="currentColor"/>' },
    INDICACAO: { bg: 'var(--sf-violet)', icon: '<circle cx="8" cy="5.5" r="2.5" fill="currentColor"/><path d="M2.5 14c.5-3 3-4.5 5.5-4.5s5 1.5 5.5 4.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/>' },
    OUTROS:    { bg: 'var(--sf-ink-3)', icon: '<path d="M3 3h5l6 6-5 5-6-6V3z" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/><circle cx="5.5" cy="5.5" r="0.8" fill="currentColor"/>' },
  };

  function originBadgeHTML(source, label) {
    const meta = ORIGIN_META[(source || '').toUpperCase()];
    const inner = meta
      ? (meta.letter
          ? `<span class="sf-origin-letter" style="color:${meta.letterColor || '#fff'}">${meta.letter}</span>`
          : `<svg viewBox="0 0 16 16">${meta.icon}</svg>`)
      : '';
    const iconHTML = meta
      ? `<span class="sf-origin-icon" style="background:${meta.bg};${meta.border ? 'border:1px solid var(--sf-line);' : ''}">${inner}</span>`
      : '';
    return `${iconHTML}<span class="sf-opp-bar-value">${escHtml(label || '—')}</span>`;
  }

  // Ícone por tipo de evento — casa palavras-chave do rótulo/tipo/descrição
  // com um emoji, pra deixar a timeline mais fácil de escanear visualmente.
  const EVENT_ICON_RULES = [
    [/pagamento|pago|cobran/i, '💰'],
    [/pesquisa|satisfa/i, '⭐'],
    [/liga(ç|c)[aã]o|telefone/i, '📞'],
    [/whatsapp|mensagem/i, '💬'],
    [/plano de tratamento/i, '📋'],
    [/tratamento|implante|limpeza|consulta|procedimento/i, '🦷'],
  ];

  function eventIconFor(item) {
    const haystack = `${item.categoryLabel || ''} ${item.type || ''} ${item.description || ''}`;
    for (const [re, icon] of EVENT_ICON_RULES) {
      if (re.test(haystack)) return icon;
    }
    return item._kind === 'scheduling' ? '📅' : '📋';
  }

  function renderTimelineList(items) {
    return `<div class="sf-activity-list">${items.map((item, idx) => renderTimelineItem(item, idx)).join('')}</div>`;
  }

  function renderTimelineItem(item, idx) {
    const isActivity = item._kind === 'activity';
    const tagOrType = isActivity
      ? escHtml(item.categoryLabel || item.type || '')
      : `${escHtml(item.type || '')}${item.modality ? ' · ' + escHtml(item.modality) : ''}`;

    // Pagamento (item 5 da spec): agendamentos já carregam totalAmount/amountPaid
    // (mesmo dado usado no modal de edição) — mostra a pill de status direto na
    // timeline quando há valor definido, sem precisar de um card separado.
    const payInfo = !isActivity ? paymentPillInfo(item.totalAmount, item.amountPaid) : null;
    const paymentHTML = payInfo ? `
          <div class="sf-timeline-payment">
            <span>💰 ${escHtml(fmtBRL(item.totalAmount))}</span>
            <span class="sf-agenda-payment-pill" style="background:${payInfo.bg};color:${payInfo.color};">${escHtml(payInfo.label)}</span>
          </div>` : '';

    return `
      <div class="sf-timeline-item sf-timeline-item-clickable" data-timeline-idx="${idx}">
        <span class="sf-timeline-icon">${eventIconFor(item)}</span>
        <div class="sf-timeline-body">
          <div class="sf-activity-meta">
            <span class="sf-activity-date">${escHtml(formatDateLabel(item.date))} ${escHtml(item.hour || '')}</span>
            ${isActivity ? `<span class="sf-activity-tag">${tagOrType}</span>` : schedulingStatusBadge(item)}
          </div>
          ${isActivity ? `<p class="sf-activity-desc">${escHtml(item.description || '')}</p>` : `<span class="sf-scheduling-type">${tagOrType}</span>`}
          ${paymentHTML}
        </div>
      </div>`;
  }

  // Clique na timeline: agendamento → modal de edição (mesmo da Agenda do
  // Dia); atividade → detalhe de leitura do registro de histórico.
  function handleCrmListClick(e) {
    const el = e.target.closest('.sf-timeline-item-clickable');
    if (!el) return;
    const item = lastTimelineItems[Number(el.getAttribute('data-timeline-idx'))];
    if (!item) return;
    if (item._kind === 'scheduling') openAgendaDetailModal(item);
    else openActivityDetailModal(item);
  }

  function openActivityDetailModal(item) {
    const dateLabel = item.date ? formatDateLabel(item.date) : '';
    const when = [dateLabel, (item.hour || '')].filter(Boolean).join(' ');
    const tag = item.categoryLabel || item.type || 'Registro';

    openModal(tag, when, `
      <div class="sf-modal-body">
        <span class="sf-modal-label sf-followup-label">Descrição</span>
        <div class="sf-activity-detail-desc">${escHtml(item.description || '—')}</div>
      </div>
    `, 'Histórico');
  }

  function potentialPct(potential) {
    return { Fraco: 33, Médio: 66, Forte: 100 }[potential] || 0;
  }

  function formatDateLabel(dateStr) {
    const parts = (dateStr || '').split('-');
    return parts.length === 3 ? `${parts[2]}/${parts[1]}` : (dateStr || '');
  }

  // Timestamp ISO (created_at/last_modified_date) -> DD/MM/AAAA.
  function formatIsoDate(iso) {
    const parts = String(iso || '').slice(0, 10).split('-');
    return parts.length === 3 && parts[0] ? `${parts[2]}/${parts[1]}/${parts[0]}` : '';
  }

  function slugify(str) {
    return (str || '')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, '-');
  }

  function field(label, value, extraClass = '', extra = '') {
    const isEmpty = !value;
    const displayVal = isEmpty
      ? `<span class="sf-field-value sf-empty">—</span>`
      : `<span class="sf-field-value ${extraClass}">${escHtml(value)}</span>`;
    return `
      <div class="sf-field">
        <span class="sf-field-label">${escHtml(label)}</span>
        ${displayVal}
        ${extra}
      </div>`;
  }

  /**
   * Faixa de aviso no topo do painel. Existe porque o retorno do envio não cabe
   * mais no modal (ele fecha no clique) nem no rodapé, que o próximo poll
   * sobrescreve: uma falha em "atualizar o CRM" precisa ficar na tela até
   * alguém ler, senão o funil deixa de andar sem ninguém perceber.
   *
   * Erro fica até ser fechado; confirmação some sozinha.
   */
  function showFlash(message, kind = 'ok') {
    const el = sidebar && sidebar.querySelector('#sf-wa-flash');
    if (!el) return;

    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }

    el.className = `sf-flash sf-flash-${kind}`;
    el.innerHTML = `
      <span class="sf-flash-text">${escHtml(message)}</span>
      <button type="button" class="sf-flash-close" title="Fechar">${closeSVG()}</button>
    `;
    el.querySelector('.sf-flash-close').addEventListener('click', hideFlash);

    if (kind === 'ok') flashTimer = setTimeout(hideFlash, 8000);
  }

  function hideFlash() {
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
    const el = sidebar && sidebar.querySelector('#sf-wa-flash');
    if (el) { el.className = 'sf-hidden-el'; el.innerHTML = ''; }
  }

  function updateTimestamp(msg) {
    const el = sidebar.querySelector('#sf-wa-updated');
    if (!el) return;
    if (msg) { el.textContent = msg; return; }
    const now = new Date();
    el.textContent = `Atualizado ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  // ─── Toggle Sidebar ───────────────────────────────────────────────────────

  function toggleSidebar() {
    isOpen = !isOpen;
    sidebar.classList.toggle('sf-hidden', !isOpen);
    collapseTab.classList.toggle('sf-hidden-tab', !isOpen);
    document.body.classList.toggle('sf-sidebar-open', isOpen);
  }

  // ─── Polling ──────────────────────────────────────────────────────────────

  // Extensão recarregada em chrome://extensions com esta aba já aberta deixa
  // o content script antigo com uma referência chrome.runtime morta — sem essa
  // checagem os timers ficam martelando "Extension context invalidated" no
  // console pra sempre, até a página ser recarregada manualmente.
  function isExtensionContextValid() {
    try {
      return !!chrome.runtime?.id;
    } catch (_) {
      return false;
    }
  }

  function startPolling() {
    pollTimer = setInterval(() => {
      if (!isExtensionContextValid()) { clearInterval(pollTimer); pollTimer = null; return; }
      scrapeAndRender();
    }, REFRESH_INTERVAL_MS);
  }

  // ─── MutationObserver (detect chat navigation) ────────────────────────────

  function observeChatChanges() {
    const observer = new MutationObserver(() => {
      const { nameEl } = getHeaderParts();
      const currentTitle = (nameEl && (nameEl.getAttribute('title') || nameEl.textContent.trim())) || '';

      if (currentTitle !== lastChatTitle) {
        lastChatTitle = currentTitle;
        currentContact = {};
        scrapeAndRender(true);
      }
    });

    // Observe the main app container
    const target = document.querySelector('#app') || document.body;
    observer.observe(target, { childList: true, subtree: true, characterData: true });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function textOf(sel) {
    const el = document.querySelector(sel);
    return el ? el.textContent.trim() || null : null;
  }

  function srcOf(sel) {
    return srcOfEl(document.querySelector(sel));
  }

  function srcOfEl(el) {
    if (!el) return null;
    const src = el.src || el.getAttribute('src');
    // Skip default/blank avatars
    if (!src || src.includes('data:image/png;base64,iVBORw0KGgo')) return null;
    return src;
  }

  function isPhoneNumber(str) {
    if (!str) return false;
    const digits = str.replace(/[\s\-\(\)\+]/g, '');
    return /^\d{7,15}$/.test(digits) && !/^\d{4}$/.test(digits);
  }

  function formatPhone(str) {
    if (!str) return null;
    const cleaned = str.replace(/[^\d\+]/g, '');
    // Already formatted or international
    if (str.includes('+') || str.includes('(')) return str.trim();
    // Raw digits — try to format as BR
    if (cleaned.length === 11) {
      return `(${cleaned.slice(0,2)}) ${cleaned.slice(2,7)}-${cleaned.slice(7)}`;
    }
    if (cleaned.length === 10) {
      return `(${cleaned.slice(0,2)}) ${cleaned.slice(2,6)}-${cleaned.slice(6)}`;
    }
    return str.trim();
  }

  function initials(name) {
    if (!name) return '?';
    return name.trim().split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  }

  function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  // ─── Branding ─────────────────────────────────────────────────────────────

  const SF_LIGHT = {
    '--sf-bg':        '#fafafe',
    '--sf-surface':   '#ffffff',
    '--sf-surface-2': '#f4f4f7',
    '--sf-surface-3': '#e9e9ee',
    '--sf-ink':       '#232333',
    '--sf-ink-2':     '#5d5d6b',
    '--sf-ink-3':     '#8c8c97',
    '--sf-line':      '#dfdfe6',
    '--sf-line-2':    '#cfcfd9',
  };

  const SF_DARK = {
    '--sf-bg':        '#10111a',
    '--sf-surface':   '#181922',
    '--sf-surface-2': '#1e2030',
    '--sf-surface-3': '#252840',
    '--sf-ink':       '#e8e8f0',
    '--sf-ink-2':     '#9898a8',
    '--sf-ink-3':     '#65657a',
    '--sf-line':      '#2a2c40',
    '--sf-line-2':    '#343654',
  };

  function logoForContext(fallbackFile) {
    if (currentBranding) {
      if (currentBranding.logoDataUrl || currentBranding.logoUrl) {
        return currentBranding.logoDataUrl || currentBranding.logoUrl;
      }
      // No custom logo: pick fallback by mode so white-text logo shows on dark bg
      if (currentBranding.theme && currentBranding.theme.mode === 'dark') {
        return logoURL('logo-sem-fundo2.png');
      }
    }
    return logoURL(fallbackFile);
  }

  function applyBranding(branding) {
    if (!branding) return;
    currentBranding = branding;

    const root = document.documentElement;
    const isDark = branding.theme && branding.theme.mode === 'dark';

    // Always explicitly set neutral tokens so tenant/mode switches apply cleanly
    const modeVars = isDark ? SF_DARK : SF_LIGHT;
    for (const [k, v] of Object.entries(modeVars)) {
      root.style.setProperty(k, v);
    }

    const BRAND_VAR_MAP = buildBrandVarMap('sf-');

    const cssVars = branding.theme && branding.theme.cssVars;
    if (cssVars) {
      for (const [key, val] of Object.entries(cssVars)) {
        const target = BRAND_VAR_MAP[key] || key;
        root.style.setProperty(target, val);
      }
      // Cabeçalho sempre na cor sólida da plataforma do tenant (--sf-navy,
      // remapeado de --navy), nunca no gradiente dos botões (--sf-grad).
      root.style.setProperty('--sf-header-bg', 'var(--sf-navy)');
      root.style.setProperty('--sf-header-glow-opacity', '0');
    }

    const logoSrc = branding.logoDataUrl || branding.logoUrl;
    if (logoSrc) {
      sidebar.querySelectorAll('.sf-logo, .sf-login-logo, .sf-empty-logo').forEach(img => {
        img.src = logoSrc;
      });
    }

  }

  // ─── SVG Icons ────────────────────────────────────────────────────────────

  function logoURL(file) {
    return chrome.runtime.getURL(`assets/${file}`);
  }

  function closeSVG() {
    return `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>`;
  }

  function homeSVG() {
    return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <path d="M2 7.5L8 2l6 5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M3.5 6.5V13a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M6.3 14v-3.3a1 1 0 0 1 1-1h1.4a1 1 0 0 1 1 1V14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }

  function logoutSVG() {
    return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3M11 11l3-3-3-3M14 8H6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }

  function linkedListSVG() {
    return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <circle cx="3" cy="4" r="1" fill="currentColor"/>
      <circle cx="3" cy="8" r="1" fill="currentColor"/>
      <circle cx="3" cy="12" r="1" fill="currentColor"/>
      <path d="M6 4h8M6 8h8M6 12h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`;
  }

  function chevronRightSVG() {
    return `<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
      <path d="M2 2l6 6-6 6" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    </svg>`;
  }

  function plusSVG() {
    return `<svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>`;
  }

  function calendarSVG() {
    return `<svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="3" width="12" height="11" rx="2" stroke="currentColor" stroke-width="1.4"/>
      <path d="M2 6.5h12M5 1.5v3M11 1.5v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    </svg>`;
  }

  function banSVG() {
    return `<svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/>
      <path d="M3.8 3.8l8.4 8.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`;
  }

  function checklistSVG() {
    return `<svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M2 4h2M2 8h2M2 12h2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      <path d="M6 4h8M6 8h8M6 12h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    </svg>`;
  }

  function railOpportunitySVG() {
    return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="5.5" r="2.8" stroke="currentColor" stroke-width="1.4"/>
      <path d="M2.5 14c.6-3.2 3-4.8 5.5-4.8s4.9 1.6 5.5 4.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    </svg>`;
  }

  function refreshSVG() {
    return `<svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3.2h-3.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }

  function railProntuarioSVG() {
    return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <rect x="3" y="2.5" width="10" height="12" rx="1.5" stroke="currentColor" stroke-width="1.3"/>
      <path d="M6 6h4M6 9h4M6 12h2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    </svg>`;
  }

})();
