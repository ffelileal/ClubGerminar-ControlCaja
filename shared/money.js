// Todos los importes se manejan en centavos enteros.
// Acepta: 1500 | "1500" | "1500,50" | "1.500,50" | "1500.50" | "1.500"
export function aCentavos(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  if (typeof valor === 'number') return Number.isFinite(valor) ? Math.round(valor * 100) : null;
  let s = String(valor).trim().replace(/[$\s]/g, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  else if (s.includes('.')) {
    const partes = s.split('.');
    if (partes.length > 2 || partes[partes.length - 1].length === 3) s = partes.join('');
  }
  if (!/^-?\d+(\.\d{0,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

const fmt = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function formatoMoneda(centavos) {
  const valor = (centavos || 0) / 100;
  if (valor < 0) return `- $ ${fmt.format(Math.abs(valor))}`;
  return `$ ${fmt.format(valor)}`;
}
