# Elo Automações — Design System (extraído p/ uso externo)

Extraído de `src/app/globals.css` + componentes do Front-End Next.js. Use isto p/ portar o
visual da Elo p/ outro sistema (ex.: extensão Chrome). Stack original: Tailwind v4 + tokens CSS
custom; aqui vai tudo em **CSS puro** p/ não depender do Tailwind.

## 1. Cores (tokens)

```css
:root {
  /* Marca */
  --brand-cyan: #29a9ff;
  --brand-blue: #2e6bff;
  --brand-violet: #7a3cf0;
  --grad: linear-gradient(118deg, #29a9ff 0%, #2e6bff 42%, #7a3cf0 100%);
  --grad-soft: linear-gradient(118deg, rgba(41, 169, 255, 0.14), rgba(122, 60, 240, 0.14));

  /* Neutros (frios) */
  --bg: #fafafe;          /* oklch(0.985 0.004 265) */
  --surface: #ffffff;
  --surface-2: #f4f4f7;   /* oklch(0.967 0.006 265) */
  --surface-3: #e9e9ee;   /* oklch(0.945 0.008 265) */
  --ink: #232333;         /* oklch(0.22 0.035 264) — texto principal */
  --ink-2: #5d5d6b;       /* oklch(0.44 0.022 264) — texto secundário */
  --ink-3: #8c8c97;       /* oklch(0.58 0.018 264) — texto terciário/legendas */
  --line: #dfdfe6;        /* oklch(0.915 0.009 265) — bordas suaves */
  --line-2: #cfcfd9;      /* oklch(0.88 0.012 265) — bordas mais fortes */

  /* Faixa navy (sidebar, headers de modal, heroes) */
  --navy: #0c1230;
  --navy-2: #131a3e;
  --on-navy-2: rgba(255, 255, 255, 0.62);

  /* Acento de chat/WhatsApp */
  --wa: #22c55e;

  /* Sombras */
  --sh-sm: 0 1px 2px rgba(13,19,48,.05), 0 1px 3px rgba(13,19,48,.06);
  --sh:    0 8px 24px -10px rgba(13,19,48,.14), 0 2px 6px rgba(13,19,48,.05);
  --sh-lg: 0 30px 70px -28px rgba(20,26,62,.34), 0 8px 24px -14px rgba(20,26,62,.18);
  --sh-brand: 0 18px 40px -16px rgba(46,107,255,.5);

  --radius-xl: 16px;
  --radius-2xl: 24px;
  --radius-3xl: 32px;
}
```

**Status/semântica (cores soltas usadas em badges):**
- Azul (Novo/Info): `#2e6bff`
- Âmbar (Em andamento/Atenção): `#d97706`
- Ciano (Agendado): `#29a9ff`
- Verde (Sucesso/Convertido): `#16a34a`
- Vermelho/Rosa (Perdido/Erro/Crítico): `#e0245e` / `#ef4444`

**Paleta de 15 cores de acento (escolhível p/ branding por cliente):**
Violeta `#7a3cf0` · Índigo `#6366f1` · Azul `#2e6bff` · Azul-céu `#0ea5e9` · Ciano `#06b6d4` ·
Teal `#14b8a6` · Esmeralda `#10b981` · Verde `#22c55e` · Lima `#84cc16` · Amarelo `#eab308` ·
Âmbar `#f59e0b` · Laranja `#f97316` · Vermelho `#ef4444` · Rosa `#ec4899` · Magenta `#d946ef`.

## 2. Tipografia

Duas fontes Google (IBM Plex), via `next/font`:

```css
font-family: "IBM Plex Sans", system-ui, -apple-system, sans-serif; /* corpo geral */
font-family: "IBM Plex Mono", ui-monospace, monospace;              /* rótulos, números, labels técnicos, botões */
```

Pesos usados: Sans `300/400/500/600/700`; Mono `400/500/600/700`.

Padrão de uso (recorrente no app):
- **Corpo/parágrafos** → Sans.
- **Labels uppercase pequenos** (eyebrow, headers de card, rótulos de stat) → Mono, `font-mono uppercase tracking-[0.1em~0.14em] text-[10.5px~11.5px] font-semibold`, cor `--ink-3` (ou `--brand-cyan` sobre navy).
- **Botões e títulos de modal** → Mono, `font-semibold`.
- Texto base do body: `color: var(--ink); -webkit-font-smoothing: antialiased;`

## 3. Gradiente de marca (elemento assinatura)

Usado em: botões primários, avatar/iniciais, item de menu ativo, header de modal, hero de página.

```css
.bg-grad { background: var(--grad); }              /* sólido p/ botões/avatares */
.bg-grad-soft { background: var(--grad-soft); }     /* fundo suave p/ ícones em destaque */
.text-grad {                                         /* texto com gradiente (uso raro hoje) */
  background: var(--grad);
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; color: transparent;
}
.shadow-brand { box-shadow: var(--sh-brand); }
```

Header navy com "glow" radial (usado em modais e heroes):
```css
.navy-glow {
  position: relative;
  background: var(--navy);
  overflow: hidden;
}
.navy-glow::before {
  content: "";
  position: absolute; inset: 0; pointer-events: none;
  background:
    radial-gradient(280px 160px at 92% -30%, rgba(122,60,240,.55), transparent 60%),
    radial-gradient(220px 160px at -5% 130%, rgba(41,169,255,.4), transparent 60%);
}
```

## 4. Componentes-base (receitas CSS)

### Botão primário (pill, gradiente)
```css
.btn-primary {
  display: inline-flex; align-items: center; gap: 8px;
  border-radius: 9999px;
  background: var(--grad);
  color: #fff;
  font-family: "IBM Plex Mono", monospace;
  font-size: 13px; /* 14px nos CTAs grandes */
  font-weight: 500;
  padding: 10px 20px; /* py-2.5 px-5 */
  box-shadow: var(--sh-brand);
  border: none;
  transition: transform .15s ease;
  cursor: pointer;
}
.btn-primary:hover { transform: translateY(-2px); }
.btn-primary:disabled { opacity: .6; cursor: not-allowed; transform: none; }
```

### Botão secundário (outline)
```css
.btn-secondary {
  display: inline-flex; align-items: center; gap: 8px;
  border-radius: 9999px;
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--ink);
  font-size: 13px; font-weight: 500;
  padding: 10px 16px;
  transition: background .15s ease;
  cursor: pointer;
}
.btn-secondary:hover { background: var(--surface); }
```

### Botão destrutivo
Mesma forma do secundário, mas `color: #ef4444; border-color: rgba(239,68,68,.35);`

### Card / seção
```css
.card {
  overflow: hidden;
  border-radius: var(--radius-2xl); /* 24px */
  border: 1px solid var(--line);
  background: var(--surface);
  box-shadow: var(--sh-sm);
}
.card-header {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  border-bottom: 1px solid var(--line);
  padding: 14px 20px;
}
.card-header h3 {
  font-family: "IBM Plex Mono", monospace;
  font-size: 11.5px; font-weight: 600;
  text-transform: uppercase; letter-spacing: .1em;
  color: var(--ink-3);
}
.card-body { padding: 16px 20px; }
.card-body--scroll { height: 300px; overflow-y: auto; }
```

### Empty state (placeholder tracejado)
```css
.empty-state {
  border: 1px dashed var(--line-2);
  border-radius: 12px;
  padding: 20px 16px;
  text-align: center;
  font-family: "IBM Plex Mono", monospace;
  font-size: 13px;
  color: var(--ink-3);
}
```

### Modal — cabeçalho padrão (`ModalHeader`)
Todo modal usa: faixa navy full-bleed no topo do container, com `.navy-glow`, eyebrow, título e
botão de fechar translúcido.
```css
.modal { border-radius: var(--radius-2xl); overflow: hidden; border: 1px solid var(--line); background: var(--surface); box-shadow: var(--sh-lg); }
.modal-header { position: relative; padding: 20px 24px; color: #fff; } /* + .navy-glow */
.modal-header .eyebrow {
  font-family: "IBM Plex Mono", monospace;
  font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .14em;
  color: var(--brand-cyan);
}
.modal-header h3 {
  margin-top: 6px;
  font-family: "IBM Plex Mono", monospace;
  font-size: 1.25rem; font-weight: 600; color: #fff;
}
.modal-header .subtitle { margin-top: 6px; font-size: 12.5px; color: rgba(255,255,255,.7); }
.modal-header .close-btn {
  position: absolute; top: 16px; right: 16px;
  display: grid; place-items: center;
  width: 32px; height: 32px; border-radius: 12px;
  background: rgba(255,255,255,.12); color: #fff; border: none; cursor: pointer;
}
.modal-header .close-btn:hover { background: rgba(255,255,255,.24); }
```

### Input de formulário
```css
.input {
  width: 100%;
  border-radius: 12px;
  border: 1.5px solid var(--line-2);
  background: var(--surface);
  padding: 8px 12px;
  font-size: 14px;
  color: var(--ink);
  outline: none;
  transition: border-color .15s ease, box-shadow .15s ease;
}
.input:focus {
  border-color: var(--brand-blue);
  box-shadow: 0 0 0 4px rgba(46,107,255,.10);
}
```

### Abas (tab pills)
```css
.tabs { display: inline-flex; flex-wrap: wrap; gap: 4px; border-radius: 9999px; border: 1px solid var(--line); background: var(--surface-2); padding: 4px; }
.tab { border-radius: 9999px; padding: 8px 14px; font-size: 13px; border: none; background: transparent; color: var(--ink-2); cursor: pointer; }
.tab[aria-selected="true"] { background: var(--surface); color: var(--ink); box-shadow: var(--sh-sm); font-weight: 600; }
```

### Badge/chip de status (dot + texto)
```css
.badge { display: inline-flex; align-items: center; gap: 6px; border-radius: 9999px; padding: 4px 10px; font-size: 12px; font-weight: 600; }
.badge .dot { width: 6px; height: 6px; border-radius: 50%; }
/* exemplo "Convertido": */
.badge--success { background: rgba(22,163,74,.10); color: #16a34a; }
.badge--success .dot { background: #16a34a; }
```
Variantes por significado: azul (`--brand-blue`/10%), âmbar (`#d97706`/10%), ciano (`--brand-cyan`/10%),
verde (`#16a34a`/10%), vermelho/rosa (`#e0245e`/10%) — sempre `cor sólida no texto+dot`, `10% de opacidade no fundo`.

### Avatar com iniciais (gradiente)
```css
.avatar {
  display: grid; place-items: center;
  border-radius: 50%;
  background: var(--grad);
  color: #fff;
  font-family: "IBM Plex Mono", monospace;
  font-weight: 600;
  width: 36px; height: 36px; /* varia 32–40px conforme contexto */
}
```

## 5. Layout — sidebar + topbar (referência do shell)

- Sidebar fixa **264px**, fundo `--navy`, padding `16px 24px` aprox., logo no topo, nav em lista
  vertical (`gap 4px`, item ativo = `.bg-grad` + sombra `--sh-brand`, item inativo =
  `color: rgba(255,255,255,.65)` com hover `background: rgba(255,255,255,.07)`).
- Cartão de usuário fixado no rodapé da sidebar: `border-radius: 16px`, `background: rgba(255,255,255,.06)`,
  `border: 1px solid rgba(255,255,255,.10)`.
- Topbar: `border-bottom: 1px solid var(--line)`, fundo `var(--bg)` a 80% + `backdrop-filter: blur(8px)`,
  altura ~64px, ações alinhadas à direita (busca/sino/perfil).
- Conteúdo principal: padding `28px 20px` (mobile) / `28px 32px` (desktop) — **sem** `max-width` central
  nas telas internas (full-width); formulários dedicados usam `max-width` centralizado por legibilidade.

## 6. Raios, sombras e movimento

- Raios: pequenos `12px`, padrão `16px` (`xl`), cards/modais `24px` (`2xl`), heroes grandes `32px` (`3xl`),
  pills sempre `9999px`.
- Sombras: `--sh-sm` em cards estáticos; `--sh` em elementos elevados (dropdowns); `--sh-lg` em modais;
  `--sh-brand` em qualquer botão/elemento usando `.bg-grad`.
- Hover padrão de botão/CTA: `transform: translateY(-2px)` com `transition` curta (~150ms).
- Entrada de elementos (pop/rise), usar com `prefers-reduced-motion` respeitado:
```css
@keyframes elo-pop  { from { opacity:0; transform: scale(.9) translateY(3px); } to { opacity:1; transform: scale(1) translateY(0); } }
@keyframes elo-rise { from { opacity:0; transform: translateY(8px); } to { opacity:1; transform: translateY(0); } }
.animate-pop  { animation: elo-pop .28s cubic-bezier(.22,1,.36,1); }
.animate-rise { animation: elo-rise .45s cubic-bezier(.22,1,.36,1) both; }
@media (prefers-reduced-motion: reduce) { .animate-pop, .animate-rise { animation: none; } }
```

## 7. Scrollbar fina (padrão do shell)
```css
.scroll-thin { scrollbar-width: thin; scrollbar-color: var(--line-2) transparent; }
.scroll-thin::-webkit-scrollbar { width: 7px; height: 7px; }
.scroll-thin::-webkit-scrollbar-thumb { background: var(--line-2); border-radius: 6px; }
```

## 8. Logo

Duas versões PNG (texto claro/escuro):
- Fundo escuro/navy → `logo-sem-fundo2.png`
- Fundo claro/branco → `logo-sem-fundo1.png`

Nunca recriar o logo como texto/SVG — sempre usar o arquivo de imagem oficial.

## 9. Resumo rápido p/ portar (cheat sheet)

| Elemento | Receita |
|---|---|
| Botão primário | pill, `background: var(--grad)`, texto branco mono, `box-shadow: var(--sh-brand)`, hover sobe 2px |
| Botão secundário | pill, borda `--line`, fundo `--surface-2` |
| Card | `border-radius: 24px`, borda `--line`, fundo branco, header com label mono uppercase cinza |
| Modal | header navy com glow radial roxo/ciano + eyebrow ciano + título branco mono |
| Badge de status | fundo na cor a 10% opacidade + texto/dot na cor sólida |
| Sidebar | navy `#0c1230`, item ativo com gradiente de marca |
| Fonte títulos/labels/botões | IBM Plex Mono | Fonte corpo | IBM Plex Sans |
| Cor de marca | gradiente `#29a9ff → #2e6bff → #7a3cf0` (118deg) |
