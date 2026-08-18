/**
 * Mapa de remapeamento das CSS vars de marca/plataforma enviadas por
 * `GET /api/branding` (`theme.cssVars`, gerado por `themeVars()` no Front-End:
 * `--brand-cyan`, `--brand-blue`, `--brand-violet`, `--grad`, `--sh-brand`,
 * `--navy`, `--navy-2`) para o namespace de CSS vars usado por cada tela da
 * extensão.
 *
 * Compartilhado entre `content.js` (namespace `--sf-*`) e `popup.js`
 * (namespace sem prefixo) para não duplicar a lista — bug corrigido aqui:
 * nenhum dos dois remapeava `--navy`/`--navy-2` (cor de plataforma do tenant),
 * então o navy do cabeçalho/painel nunca refletia a cor configurada.
 *
 * Sem `export`/módulo ES — listado antes de `content.js`/`popup.js` no
 * `manifest.json`/`popup.html`, compartilha o escopo global do isolated world.
 */

function buildBrandVarMap(prefix) {
  return {
    '--brand-cyan':   `--${prefix}cyan`,
    '--brand-blue':   `--${prefix}blue`,
    '--brand-violet': `--${prefix}violet`,
    '--grad':         `--${prefix}grad`,
    '--sh-brand':     `--${prefix}sh-brand`,
    '--navy':         `--${prefix}navy`,
    '--navy-2':       `--${prefix}navy-2`,
  };
}
