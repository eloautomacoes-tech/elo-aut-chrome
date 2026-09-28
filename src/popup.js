const viewLogin = document.getElementById('view-login');
const viewLogged = document.getElementById('view-logged');
const loginForm = document.getElementById('login-form');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const loggedEmail = document.getElementById('logged-email');
const logoutBtn = document.getElementById('logout-btn');
const envButtons = document.querySelectorAll('.env-btn');
const envNote = document.getElementById('env-note');

init();

async function init() {
  await renderEnv();
  const state = await sendMessage({ type: 'GET_AUTH_STATE' });
  render(state.authenticated, state.email);
  if (state.authenticated) {
    const res = await sendMessage({ type: 'GET_BRANDING' });
    applyBranding(res && res.branding);
  }
}

// ─── Ambiente da API (produção x app local na 3001) ─────────────────────────
// Só marca o botão ativo; a decisão de qual base usar mora no background.js,
// que é quem guarda os tokens.

async function renderEnv() {
  const res = await sendMessage({ type: 'GET_API_BASE' });
  const isDev = !!(res && res.isDev);
  envButtons.forEach((btn) => {
    btn.classList.toggle('env-btn-active', (btn.dataset.env === 'dev') === isDev);
  });
  if (isDev) {
    envNote.textContent = 'Apontando para o app local (http://localhost:3001). Suba o docker antes de entrar.';
    envNote.style.display = 'block';
  } else {
    envNote.style.display = 'none';
  }
}

envButtons.forEach((btn) => {
  btn.addEventListener('click', async () => {
    const result = await sendMessage({ type: 'SET_API_BASE', env: btn.dataset.env });
    await renderEnv();
    // Trocar de ambiente encerra a sessão (o token do outro ambiente não vale) —
    // a tela volta para o login.
    if (result && result.changed) render(false);
  });
});

function render(authenticated, email) {
  viewLogin.classList.toggle('hidden', authenticated);
  viewLogged.classList.toggle('hidden', !authenticated);
  if (authenticated) loggedEmail.textContent = email;
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  loginError.style.display = 'none';
  loginBtn.disabled = true;
  loginBtn.textContent = 'Entrando...';

  const result = await sendMessage({ type: 'LOGIN', email, password });

  loginBtn.disabled = false;
  loginBtn.textContent = 'Entrar';

  if (!result.ok) {
    loginError.textContent = result.error;
    loginError.style.display = 'block';
    return;
  }

  render(true, email);
  const res = await sendMessage({ type: 'GET_BRANDING' });
  applyBranding(res && res.branding);
});

logoutBtn.addEventListener('click', async () => {
  await sendMessage({ type: 'LOGOUT' });
  render(false);
});

const POPUP_LIGHT = {
  '--bg':        '#fafafe',
  '--surface':   '#ffffff',
  '--surface-2': '#f4f4f7',
  '--ink':       '#232333',
  '--ink-2':     '#5d5d6b',
  '--ink-3':     '#8c8c97',
  '--line':      '#dfdfe6',
  '--line-2':    '#cfcfd9',
};

const POPUP_DARK = {
  '--bg':        '#10111a',
  '--surface':   '#181922',
  '--surface-2': '#1e2030',
  '--ink':       '#e8e8f0',
  '--ink-2':     '#9898a8',
  '--ink-3':     '#65657a',
  '--line':      '#2a2c40',
  '--line-2':    '#343654',
};

function applyBranding(branding) {
  if (!branding) return;

  const root = document.documentElement;
  const isDark = branding.theme && branding.theme.mode === 'dark';

  const modeVars = isDark ? POPUP_DARK : POPUP_LIGHT;
  for (const [k, v] of Object.entries(modeVars)) {
    root.style.setProperty(k, v);
  }

  const BRAND_VAR_MAP = buildBrandVarMap('');

  const cssVars = branding.theme && branding.theme.cssVars;
  if (cssVars) {
    for (const [key, val] of Object.entries(cssVars)) {
      const target = BRAND_VAR_MAP[key] || key;
      root.style.setProperty(target, val);
    }
  }

  const logoSrc = branding.logoDataUrl || branding.logoUrl;
  if (logoSrc) {
    const img = document.querySelector('.header img');
    if (img) img.src = logoSrc;
  }

  if (branding.title) {
    const subtitle = document.querySelector('.header p');
    if (subtitle) subtitle.textContent = branding.title;
  }
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, resolve);
  });
}
