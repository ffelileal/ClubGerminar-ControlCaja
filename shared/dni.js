// Parser y validación de documentos. Compartido por frontend y backend.
//
// Formatos soportados:
//  - DNI argentino "tarjeta" (PDF417 frente):
//      00123456789@APELLIDO@NOMBRES@M@12345678@A@01/01/1990@01/01/2015@200
//  - DNI argentino libreta/antiguo (PDF417 dorso), comienza con '@':
//      @12345678    @A@1@APELLIDO@NOMBRES@ARGENTINA@01/01/1980@M@...
//  - Número tipeado manualmente (admite puntos y espacios: 12.345.678)
//
// Muchos lectores configurados con distribución de teclado distinta envían
// comillas (") en lugar de arroba (@). Se normaliza automáticamente.

export const DNI_DEFAULTS = { min: 7, max: 8, alfanumerico: false };

export function parseDocumento(raw, opts = {}) {
  const cfg = { ...DNI_DEFAULTS, ...opts };
  if (typeof raw !== 'string') return { ok: false, error: 'Lectura vacía' };
  let s = raw.replace(/[\r\n\t]/g, '').trim();
  if (!s) return { ok: false, error: 'Lectura vacía' };

  if (!s.includes('@') && (s.match(/"/g) || []).length >= 3) s = s.replace(/"/g, '@');

  let numero = null;
  let apellido = null;
  let nombre = null;
  let sexo = null;
  let fechaNacimiento = null;
  let origen = 'manual';

  if (s.includes('@')) {
    const f = s.split('@').map((x) => x.trim());
    if (s.startsWith('@')) {
      // Formato antiguo
      numero = f[1];
      apellido = f[4] || null;
      nombre = f[5] || null;
      sexo = f[8] || f[3] || null;
      fechaNacimiento = f[7] || null;
      origen = 'pdf417-antiguo';
    } else if (f.length >= 8) {
      numero = f[4];
      apellido = f[1] || null;
      nombre = f[2] || null;
      sexo = f[3] || null;
      fechaNacimiento = f[6] || null;
      origen = 'pdf417';
    } else {
      return { ok: false, error: 'Código no reconocido como DNI' };
    }
  } else {
    numero = s;
  }

  numero = String(numero || '').replace(/[.\s-]/g, '').toUpperCase();
  const v = validarNumero(numero, cfg);
  if (!v.ok) return v;
  return { ok: true, dni: v.dni, apellido, nombre, sexo, fechaNacimiento, origen };
}

export function validarNumero(numero, opts = {}) {
  const cfg = { ...DNI_DEFAULTS, ...opts };
  const n = String(numero || '').replace(/[.\s-]/g, '').toUpperCase();
  if (!n) return { ok: false, error: 'Ingrese un número de documento' };
  if (/^\d+$/.test(n)) {
    const sinCeros = n.replace(/^0+/, '') || '0';
    if (sinCeros.length < cfg.min || sinCeros.length > cfg.max)
      return { ok: false, error: `El DNI debe tener entre ${cfg.min} y ${cfg.max} dígitos` };
    return { ok: true, dni: sinCeros };
  }
  if (cfg.alfanumerico && /^[A-Z0-9]{5,15}$/.test(n)) return { ok: true, dni: n };
  return { ok: false, error: 'Formato de documento inválido (solo números)' };
}

/** Enmascara un documento para listados: 12345678 -> ****5678 */
export function enmascarar(dni) {
  if (!dni) return '';
  const s = String(dni);
  return s.length <= 3 ? '***' : '•'.repeat(s.length - 3) + s.slice(-3);
}
