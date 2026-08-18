/**
 * Máscaras de dados brasileiros — telefone, CPF, CNPJ e CEP.
 * Porte vanilla JS de `src/lib/masks.ts` (Front-End) — mesma regra do projeto:
 * salvar sempre SEM máscara (só dígitos), exibir sempre COM máscara.
 *
 * Sem `export`/módulo ES — content script clássico, listado antes de
 * `content.js` no `manifest.json`, compartilha o escopo global do isolated
 * world da extensão. Namespace `EloMasks` evita poluir o global com nomes
 * genéricos (`unmask`, `maskPhone`, ...).
 */

const EloMasks = (function () {
  /** Remove tudo que não for dígito. É também o `unmask` usado antes de salvar. */
  function onlyDigits(s) {
    return (s ?? '').replace(/\D/g, '');
  }

  /** Alias semântico: o que se grava no banco é sempre sem máscara. */
  const unmask = onlyDigits;

  /**
   * Telefone: `(11) 98765-4321` (11 díg.) ou `(11) 3456-7890` (10 díg.).
   * Progressivo — formata parcialmente enquanto o usuário digita.
   */
  function maskPhone(value) {
    const d = onlyDigits(value).slice(0, 11);
    if (d.length === 0) return '';
    if (d.length <= 2) return `(${d}`;
    if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }

  /** CPF: `123.456.789-00` (progressivo). */
  function maskCpf(value) {
    const d = onlyDigits(value).slice(0, 11);
    if (d.length <= 3) return d;
    if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
    if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
    return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  }

  /** CNPJ: `12.345.678/0001-90` (progressivo). */
  function maskCnpj(value) {
    const d = onlyDigits(value).slice(0, 14);
    if (d.length <= 2) return d;
    if (d.length <= 5) return `${d.slice(0, 2)}.${d.slice(2)}`;
    if (d.length <= 8) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5)}`;
    if (d.length <= 12) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8)}`;
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }

  /** CPF ou CNPJ conforme a quantidade de dígitos (≤ 11 → CPF; senão CNPJ). */
  function maskCpfCnpj(value) {
    return onlyDigits(value).length > 11 ? maskCnpj(value) : maskCpf(value);
  }

  /** CEP: `12345-678` (progressivo). */
  function maskCep(value) {
    const d = onlyDigits(value).slice(0, 8);
    if (d.length <= 5) return d;
    return `${d.slice(0, 5)}-${d.slice(5)}`;
  }

  /** Aplica a máscara pela `kind` ('phone'|'cpf'|'cnpj'|'document'|'cep'). `document` decide CPF/CNPJ pelo tamanho. */
  function applyMask(kind, value) {
    switch (kind) {
      case 'phone': return maskPhone(value);
      case 'cpf': return maskCpf(value);
      case 'cnpj': return maskCnpj(value);
      case 'document': return maskCpfCnpj(value);
      case 'cep': return maskCep(value);
      default: return value ?? '';
    }
  }

  /** Igual a `applyMask`, mas retorna `null` quando não há dígito — útil na exibição. */
  function maskOrNull(kind, value) {
    if (!onlyDigits(value)) return null;
    return applyMask(kind, value);
  }

  return { onlyDigits, unmask, maskPhone, maskCpf, maskCnpj, maskCpfCnpj, maskCep, applyMask, maskOrNull };
})();
