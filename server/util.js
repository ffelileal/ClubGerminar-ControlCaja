export class AppError extends Error {
  constructor(status, codigo, mensaje, extra) {
    super(mensaje);
    this.status = status;
    this.codigo = codigo;
    this.extra = extra;
  }
}

export const err = {
  validacion: (m, extra) => new AppError(400, 'VALIDACION', m, extra),
  noAuth: (m = 'Sesión no válida. Ingrese nuevamente.') => new AppError(401, 'NO_AUTENTICADO', m),
  prohibido: (m = 'No tiene permisos para esta acción') => new AppError(403, 'PROHIBIDO', m),
  noExiste: (m = 'No encontrado') => new AppError(404, 'NO_EXISTE', m),
  conflicto: (codigo, m, extra) => new AppError(409, codigo, m, extra),
};

const pad = (n) => String(n).padStart(2, '0');
/** Fecha/hora local del servidor en formato 'YYYY-MM-DD HH:MM:SS' (ordenable y agrupable en SQL). */
export function ahora(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export function hoy(d = new Date()) {
  return ahora(d).slice(0, 10);
}
export function sumarDias(fechaISO, dias) {
  const [y, m, d] = fechaISO.split('-').map(Number);
  const dt = new Date(y, m - 1, d + dias);
  return hoy(dt);
}
