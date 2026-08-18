/**
 * Background service worker — único lugar que guarda os tokens e fala com a API.
 * content.js e popup.js só trocam mensagens com este arquivo, nunca veem os tokens.
 *
 * Fluxo de tokens:
 *   - accessToken  → curta duração (~15 min), usado em todas as chamadas
 *   - refreshToken → longa duração (~30 dias), usado só para renovar o accessToken
 *   - Antes de cada chamada, getValidToken() verifica expiração e renova se necessário
 */

const API_BASE = 'https://eloautomacoes.com.br';

// Buffer de 30s: renova o accessToken se ele expira em menos de 30 segundos
const TOKEN_EXPIRY_BUFFER_MS = 30_000;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse);
  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case 'LOGIN':
      return login(message.email, message.password);
    case 'LOGOUT':
      return logout();
    case 'GET_AUTH_STATE':
      return getAuthState();
    case 'GET_BRANDING':
      return getBranding();
    case 'LOOKUP_CONTACT':
      return lookupContact(message.name);
    case 'GET_PENDING_OPPORTUNITIES':
      return getPendingOpportunities();
    case 'LINK_OPPORTUNITY':
      return linkOpportunity(message.opportunityId, message.name);
    case 'UNLINK_OPPORTUNITY':
      return unlinkOpportunity(message.opportunityId);
    case 'GET_LINKED_OPPORTUNITIES':
      return getLinkedOpportunities();
    case 'CREATE_OPPORTUNITY':
      return createOpportunity(message.fields);
    case 'UPDATE_OPPORTUNITY':
      return updateOpportunity(message.fields);
    case 'CREATE_SCHEDULING':
      return createScheduling(message.fields);
    case 'UPDATE_SCHEDULING':
      return updateScheduling(message.fields);
    case 'CANCEL_SCHEDULING':
      return cancelScheduling(message.id);
    case 'CREATE_EVENT':
      return createEvent(message.fields);
    case 'UPDATE_EVENT':
      return updateEvent(message.fields);
    case 'CREATE_ACTIVITY':
      return createActivity(message.fields);
    case 'UPDATE_ACTIVITY':
      return updateActivity(message.fields);
    case 'COMPLETE_ACTIVITY':
      return completeActivity(message.id);
    case 'CANCEL_ACTIVITY':
      return cancelActivity(message.id);
    case 'GET_AGENDA_TODAY':
      return getAgendaToday();
    case 'GET_FOLLOWUPS_TODAY':
      return getFollowUpsToday();
    case 'GET_PROFESSIONALS':
      return getProfessionals();
    case 'GET_OPPORTUNITIES':
      return getOpportunities();
    default:
      return { ok: false, error: 'unknown_message' };
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────

async function login(email, password) {
  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      return { ok: false, error: 'Credenciais inválidas' };
    }

    const data = await res.json();
    await chrome.storage.local.set({
      accessToken: data.accessToken,
      accessTokenExpiresAt: data.accessTokenExpiresAt,
      refreshToken: data.refreshToken,
      refreshTokenExpiresAt: data.refreshTokenExpiresAt,
      email,
    });

    await fetchAndStoreBranding();

    return { ok: true };
  } catch (err) {
    return { ok: false, error: 'Falha ao conectar na API' };
  }
}

async function logout() {
  const { refreshToken } = await chrome.storage.local.get(['refreshToken']);

  if (refreshToken) {
    try {
      await fetch(`${API_BASE}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
    } catch (_) {
      // Falha ao invalidar no servidor não deve impedir o logout local
    }
  }

  await chrome.storage.local.remove([
    'accessToken', 'accessTokenExpiresAt',
    'refreshToken', 'refreshTokenExpiresAt',
    'email', 'branding',
  ]);
  return { ok: true };
}

async function getAuthState() {
  const { email } = await chrome.storage.local.get(['email']);
  const token = await getValidToken();

  if (!token) {
    return { ok: true, authenticated: false };
  }

  let { branding } = await chrome.storage.local.get(['branding']);
  if (!branding) {
    await fetchAndStoreBranding();
    ({ branding } = await chrome.storage.local.get(['branding']));
  }

  const me = branding && branding.me;
  return { ok: true, authenticated: true, email, userId: me && me.userId, role: me && me.role, appBase: API_BASE };
}

// ─── Token Management ─────────────────────────────────────────────────────

/**
 * Returns a valid accessToken, refreshing it if necessary.
 * Returns null if the user is not authenticated or the refresh fails.
 */
async function getValidToken() {
  const { accessToken, accessTokenExpiresAt, refreshToken } =
    await chrome.storage.local.get(['accessToken', 'accessTokenExpiresAt', 'refreshToken']);

  if (!accessToken) return null;

  const expiresAt = new Date(accessTokenExpiresAt).getTime();
  if (Date.now() < expiresAt - TOKEN_EXPIRY_BUFFER_MS) {
    return accessToken;
  }

  // Access token expired — try to refresh
  if (!refreshToken) {
    await logout();
    return null;
  }

  return refreshTokens(refreshToken);
}

async function refreshTokens(refreshToken) {
  try {
    const res = await fetch(`${API_BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (!res.ok) {
      await logout();
      return null;
    }

    const data = await res.json();
    await chrome.storage.local.set({
      accessToken: data.accessToken,
      accessTokenExpiresAt: data.accessTokenExpiresAt,
      refreshToken: data.refreshToken,
      refreshTokenExpiresAt: data.refreshTokenExpiresAt,
    });

    return data.accessToken;
  } catch (_) {
    return null;
  }
}

// ─── Branding ─────────────────────────────────────────────────────────────

async function getBranding() {
  // Sempre busca fresco da API (não confia só no cache): sem isso, uma troca de
  // cor/logo da plataforma feita depois do login só apareceria após logout+login.
  // fetchAndStoreBranding() só sobrescreve o cache se a chamada tiver sucesso —
  // offline/erro mantém o último branding válido em vez de zerar.
  await fetchAndStoreBranding();
  const { branding } = await chrome.storage.local.get(['branding']);
  return { ok: true, branding: branding || null };
}

async function fetchAndStoreBranding() {
  const token = await getValidToken();
  if (!token) return;

  try {
    const res = await fetch(`${API_BASE}/api/branding`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = await res.json();

    // Fetch logo as data URL — content scripts can't load external images
    // blocked by WhatsApp Web's img-src CSP; background SW has no such restriction.
    if (data.logoUrl) {
      try {
        const imgRes = await fetch(data.logoUrl);
        if (imgRes.ok) {
          const buffer = await imgRes.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binary = '';
          const chunk = 8192;
          for (let i = 0; i < bytes.byteLength; i += chunk) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
          }
          const mime = imgRes.headers.get('content-type') || 'image/png';
          data.logoDataUrl = `data:${mime};base64,${btoa(binary)}`;
        }
      } catch (_) { }
    }

    await chrome.storage.local.set({ branding: data });
  } catch (_) { }
}

// ─── API ──────────────────────────────────────────────────────────────────

async function lookupContact(name) {
  const token = await getValidToken();
  if (!token) return { ok: false, error: 'not_authenticated' };

  try {
    const res = await fetch(`${API_BASE}/api/whatsapp-lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name }),
    });

    if (res.status === 401) {
      await logout();
      return { ok: false, error: 'not_authenticated' };
    }

    if (res.status === 404) return { ok: true, found: false };
    if (!res.ok) return { ok: false, error: 'Erro ao buscar contato' };

    const data = await res.json();
    if (!data.found) return { ok: true, found: false };

    return {
      ok: true,
      found: true,
      contact: data.contact,
      activities: (data.activities || []).slice(0, 5),
      schedulings: (data.schedulings || []).slice(0, 5),
    };
  } catch (err) {
    return { ok: false, error: 'Falha ao conectar na API' };
  }
}

async function getPendingOpportunities() {
  const token = await getValidToken();
  if (!token) return { ok: false, error: 'not_authenticated' };

  try {
    const res = await fetch(`${API_BASE}/api/whatsapp-pending`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 401) {
      await logout();
      return { ok: false, error: 'not_authenticated' };
    }

    if (!res.ok) return { ok: false, error: 'Erro ao buscar oportunidades pendentes' };

    const data = await res.json();
    return { ok: true, opportunities: data.opportunities || [] };
  } catch (err) {
    return { ok: false, error: 'Falha ao conectar na API' };
  }
}

async function linkOpportunity(opportunityId, name) {
  const token = await getValidToken();
  if (!token) return { ok: false, error: 'not_authenticated' };

  try {
    const res = await fetch(`${API_BASE}/api/whatsapp-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ opportunityId, name }),
    });

    if (res.status === 401) {
      await logout();
      return { ok: false, error: 'not_authenticated' };
    }

    if (!res.ok) return { ok: false, error: 'Erro ao vincular contato' };

    return { ok: true };
  } catch (err) {
    return { ok: false, error: 'Falha ao conectar na API' };
  }
}

async function unlinkOpportunity(opportunityId) {
  const token = await getValidToken();
  if (!token) return { ok: false, error: 'not_authenticated' };

  try {
    const res = await fetch(`${API_BASE}/api/whatsapp-unlink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ opportunityId }),
    });

    if (res.status === 401) {
      await logout();
      return { ok: false, error: 'not_authenticated' };
    }

    if (!res.ok) return { ok: false, error: 'Erro ao desvincular contato' };

    return { ok: true };
  } catch (err) {
    return { ok: false, error: 'Falha ao conectar na API' };
  }
}

async function getLinkedOpportunities() {
  const token = await getValidToken();
  if (!token) return { ok: false, error: 'not_authenticated' };

  try {
    const res = await fetch(`${API_BASE}/api/whatsapp-linked`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 401) {
      await logout();
      return { ok: false, error: 'not_authenticated' };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[whatsapp-linked]', res.status, body);
      return { ok: false, error: `Erro ao buscar contatos vinculados (status ${res.status})` };
    }

    const data = await res.json();
    return { ok: true, opportunities: data.opportunities || [] };
  } catch (err) {
    return { ok: false, error: 'Falha ao conectar na API' };
  }
}

// ─── Criação/edição das 4 entidades + listas "do dia" (novas Route Handlers) ──
//
// apiPost/apiGet cobrem o boilerplate comum (token, 401 → logout, erro de rede)
// pras rotas novas — mesmo padrão dos handlers acima, só sem repetir por rota.

async function apiPost(path, body) {
  const token = await getValidToken();
  if (!token) return { ok: false, error: 'not_authenticated' };

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

    if (res.status === 401) {
      await logout();
      return { ok: false, error: 'not_authenticated' };
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || 'Erro ao processar a solicitação' };

    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: 'Falha ao conectar na API' };
  }
}

async function apiGet(path) {
  const token = await getValidToken();
  if (!token) return { ok: false, error: 'not_authenticated' };

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 401) {
      await logout();
      return { ok: false, error: 'not_authenticated' };
    }

    if (!res.ok) return { ok: false, error: 'Erro ao buscar dados' };

    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, error: 'Falha ao conectar na API' };
  }
}

async function createOpportunity(fields) {
  return apiPost('/api/opportunity-create', fields);
}

async function updateOpportunity(fields) {
  return apiPost('/api/opportunity-update', fields);
}

async function createScheduling(fields) {
  return apiPost('/api/scheduling-create', fields);
}

async function updateScheduling(fields) {
  return apiPost('/api/scheduling-update', fields);
}

async function cancelScheduling(id) {
  return apiPost('/api/scheduling-cancel', { id });
}

async function createEvent(fields) {
  return apiPost('/api/event-create', fields);
}

async function updateEvent(fields) {
  return apiPost('/api/event-update', fields);
}

async function createActivity(fields) {
  return apiPost('/api/activity-create', fields);
}

async function updateActivity(fields) {
  return apiPost('/api/activity-update', fields);
}

async function completeActivity(id) {
  return apiPost('/api/activity-complete', { id });
}

async function cancelActivity(id) {
  return apiPost('/api/activity-cancel', { id });
}

async function getAgendaToday() {
  const result = await apiGet('/api/agenda-today');
  if (!result.ok) return result;
  return { ok: true, agenda: result.data || [] };
}

async function getFollowUpsToday() {
  const result = await apiGet('/api/followups-today');
  if (!result.ok) return result;
  return { ok: true, followUps: result.data || [] };
}

async function getProfessionals() {
  const result = await apiGet('/api/professionals');
  if (!result.ok) return result;
  return { ok: true, professionals: (result.data && result.data.professionals) || [] };
}

async function getOpportunities() {
  const result = await apiGet('/api/opportunities-list');
  if (!result.ok) return result;
  return { ok: true, opportunities: (result.data && result.data.opportunities) || [] };
}
