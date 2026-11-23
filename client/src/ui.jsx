import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { formatoMoneda } from '../../shared/money.js';

export const $ = formatoMoneda;

// ---------- Sonidos de confirmación (sin archivos) ----------
let ctx;
export function beep(tipo = 'ok') {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    const tonos = tipo === 'ok' ? [[880, 0], [1320, 0.09]] : [[220, 0], [180, 0.16]];
    for (const [f, t] of tonos) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = tipo === 'ok' ? 'sine' : 'square';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(tipo === 'ok' ? 0.18 : 0.08, ctx.currentTime + t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.14);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.16);
    }
  } catch { /* sin audio */ }
}

// ---------- Toasts ----------
const ToastCtx = createContext(() => {});
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((msg, tipo = 'info', ms = 3800) => {
    const id = Math.random();
    setItems((x) => [...x, { id, msg, tipo }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), ms);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast ${t.tipo}`}>{t.msg}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---------- Modal ----------
export function Modal({ titulo, children, onClose, footer, wide }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-h"><h2 className="grow">{titulo}</h2><button className="btn ghost sm" onClick={onClose} aria-label="Cerrar">✕</button></div>
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- Estados ----------
const ESTADOS = {
  DENTRO: ['info', 'Dentro'],
  FINALIZADA: ['neutral', 'Finalizada'],
  ANULADA: ['bad', 'Anulada'],
  PAGADO: ['ok', 'Pagado'],
  PENDIENTE: ['warn', 'Pendiente verif.'],
  ABIERTA: ['ok', 'Abierta'],
  CERRADA: ['neutral', 'Cerrada'],
};
export function Estado({ v }) {
  if (!v) return <span className="muted">—</span>;
  const [c, t] = ESTADOS[v] || ['neutral', v];
  return <span className={`chip ${c}`}>{t}</span>;
}
export const MEDIO = { EFECTIVO: 'Efectivo', TRANSFERENCIA: 'Transferencia' };

export const hora = (s) => (s ? s.slice(11, 16) : '—');
export const fecha = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '—');
export const fechaHora = (s) => (s ? `${fecha(s)} ${hora(s)}` : '—');
export const duracion = (min) => {
  if (min == null) return '—';
  const h = Math.floor(min / 60);
  return h ? `${h} h ${String(min % 60).padStart(2, '0')} min` : `${min} min`;
};
export const nroOrden = (n) => String(n).padStart(6, '0');

/** Input monetario: acepta "1500", "1.500,50", etc. Devuelve centavos via onValor. */
export function MoneyInput({ value, onChange, className = '', ...rest }) {
  return (
    <input
      inputMode="decimal"
      autoComplete="off"
      className={`input num ${className}`}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/[^\d.,]/g, ''))}
      {...rest}
    />
  );
}

export function useAsync(fn, deps) {
  const [state, set] = useState({ cargando: true, data: null, error: null });
  const ref = useRef(0);
  const run = useCallback(async () => {
    const id = ++ref.current;
    set((s) => ({ ...s, cargando: true }));
    try {
      const data = await fn();
      if (id === ref.current) set({ cargando: false, data, error: null });
    } catch (error) {
      if (id === ref.current) set((s) => ({ cargando: false, data: s.data, error }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { ...state, recargar: run };
}

export function abrirImpresion(url) {
  const w = window.open(url, '_blank', 'width=420,height=700');
  if (!w) window.location.href = url;
}
