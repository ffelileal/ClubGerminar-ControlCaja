import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import Chart from 'chart.js/auto';
import { api, nuevaClave, onConexion, qs, setOnNoAuth } from './api.js';
import { $, abrirImpresion, beep, Estado, fechaHora, hora, Modal, MoneyInput, nroOrden, ToastProvider, useAsync, useToast } from './ui.jsx';
import { aCentavos } from '../../shared/money.js';
import './styles.css';

function Login({ onLogin, config }) {
  const [usuario, setUsuario] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function enviar(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api('/auth/login', { method: 'POST', body: { usuario, password } });
      onLogin(r.usuario, r.config);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  const establecimiento = config?.establecimiento || 'Establecimiento';
  const direccion = config?.direccion || '';
  return <div className="login-wrap"><form className="login panel" onSubmit={enviar}>
    <div className="login-brand">
      <img className="login-logo" src="/club-germinar.png" alt={establecimiento} />
      <div><strong>{establecimiento}</strong>{direccion && <small>{direccion}</small>}<span>Sistema de ingreso y caja</span></div>
    </div>
    <div className="panel-b stack">
      <label className="f">Usuario<input className="input lg" value={usuario} onChange={(e) => setUsuario(e.target.value)} autoFocus /></label>
      <label className="f">Contraseña<input className="input lg" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      {error && <div className="field-err">{error}</div>}
      <button className="btn primary lg block" disabled={busy}>{busy ? 'Ingresando...' : 'Ingresar'}</button>
    </div>
  </form></div>;
}

function Shell({ yo, config, onLogout }) {
  const [conectado, setConectado] = useState(true);
  const [menuMovil, setMenuMovil] = useState(false);
  useEffect(() => onConexion(setConectado), []);
  const nav = [
    ['/', 'Operación', '1'], ['/caja', 'Caja', '2'], ['/dashboard', 'Dashboard', '3'],
    ['/historial', 'Historial', '4'], ...(yo.rol === 'admin' ? [['/admin', 'Administración', '5']] : []),
  ];
  return <div className="app">
    {!conectado && <div className="banner bad" style={{ position: 'fixed', zIndex: 200, left: 220, right: 0, top: 0 }}>Sin conexión con el servidor</div>}
    <header className="mobile-header">
      <button className="menu-hamburguesa" onClick={() => setMenuMovil((v) => !v)} aria-label="Abrir menú" aria-expanded={menuMovil}>
        <span></span><span></span><span></span>
      </button>
      <img src="/club-germinar.png" alt="" />
      <div><strong>{config.establecimiento || 'Establecimiento'}</strong>{config.direccion && <small>{config.direccion}</small>}</div>
    </header>
    {menuMovil && <button className="menu-movil-fondo" aria-label="Cerrar menú" onClick={() => setMenuMovil(false)} />}
    <aside className={`side ${menuMovil ? 'menu-movil-abierto' : ''}`}>
      <div className="brand establishment-brand">
        <img src="/club-germinar.png" alt="" />
        <span>{config.establecimiento || 'Establecimiento'}<small>{config.direccion || ''}</small></span>
      </div>
      <nav className="nav">{nav.map(([to, label, key]) => <NavLink key={to} to={to} end={to === '/'} onClick={() => setMenuMovil(false)}>{label}<span className="key">{key}</span></NavLink>)}</nav>
      <div className="bottom"><div className="who"><b>{yo.nombre}</b>{yo.rol}</div><button onClick={onLogout}>Cerrar sesión</button></div>
    </aside>
    <main className="main"><Routes>
      <Route path="/" element={<Operacion />} />
      <Route path="/caja" element={<Caja />} />
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/historial" element={<Historial />} />
      {yo.rol === 'admin' && <Route path="/admin" element={<Admin />} />}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes></main>
  </div>;
}

function Operacion() {
  const toast = useToast();
  const scanRef = useRef(null);
  const [dni, setDni] = useState('');
  const [resultado, setResultado] = useState(null);
  const [cantidad, setCantidad] = useState(1);
  const [tarifas, setTarifas] = useState([]);
  const [tarifaId, setTarifaId] = useState('');
  const [medio, setMedio] = useState('EFECTIVO');
  const [recibido, setRecibido] = useState('');
  const [referencia, setReferencia] = useState('');
  const [verificada, setVerificada] = useState(false);
  const [nombre, setNombre] = useState('');
  const [apellido, setApellido] = useState('');
  const [busy, setBusy] = useState(false);
  const activas = useAsync(() => api('/visitas/activas'), []);
  const cfg = useAsync(() => api('/auth/me'), []);

  useEffect(() => { scanRef.current?.focus(); }, []);
  useEffect(() => {
    if (!resultado || resultado.accion !== 'INGRESO') return;
    api(`/tarifas/compatibles/${cantidad}`).then((rows) => {
      setTarifas(rows);
      setTarifaId((actual) => rows.some((t) => t.id === Number(actual)) ? actual : (rows[0]?.id ? String(rows[0].id) : ''));
    }).catch(() => setTarifas([]));
  }, [resultado?.accion, cantidad]);
  function limpiar() { setResultado(null); setDni(''); setCantidad(1); setRecibido(''); setReferencia(''); setVerificada(false); setTarifaId(''); setNombre(''); setApellido(''); setMedio('EFECTIVO'); setTimeout(() => scanRef.current?.focus(), 20); }

  async function escanear(e, lecturaOverride) {
    e.preventDefault();
    const lectura = (lecturaOverride ?? dni).trim();
    if (!lectura || busy) return;
    setBusy(true);
    try {
      const r = await api('/operacion/escaneo', { method: 'POST', body: { lectura } });
      setResultado(r); setCantidad(r.visita?.cantidad || 1);
      setNombre(r.nombre || '');
      setApellido(r.apellido || '');
      setTarifaId('');
      if (r.accion === 'EGRESO') setRecibido(r.tarifa ? (r.tarifa.precio / 100).toFixed(2).replace('.', ',') : '');
    } catch (e) { toast(e.message, 'bad'); beep('bad'); }
    finally { setBusy(false); }
  }

  async function registrarIngreso() {
    if (!tarifaId) {
      toast('Seleccione una tarifa compatible', 'bad');
      return;
    }
    if (medio === 'TRANSFERENCIA' && !verificada) {
      toast('Confirme que recibió y verificó la transferencia', 'bad');
      return;
    }
    setBusy(true);
    try {
      const o = await api('/visitas', { method: 'POST', reintentos: 2, body: {
        dni: resultado.dni,
        nombre,
        apellido,
        cantidad,
        tarifaId: Number(tarifaId),
        medio,
        recibido: medio === 'EFECTIVO' ? aCentavos(recibido) : null,
        referencia: medio === 'TRANSFERENCIA' ? referencia : null,
        verificada,
        idemKey: nuevaClave(),
      } });
      beep('ok'); toast('Ingreso registrado y cobrado', 'ok'); activas.recargar();
      setResultado({ ...resultado, cobrado: o });
    } catch (e) { toast(e.message, 'bad'); beep('bad'); }
    finally { setBusy(false); }
  }

  async function confirmarEgreso() {
    if (!resultado?.visita) return;
    setBusy(true);
    try {
      await api(`/visitas/${resultado.visita.id}/egresar`, { method: 'POST' });
      beep('ok'); activas.recargar();
      setResultado({ ...resultado, egresado: true });
      toast('Egreso registrado', 'ok');
    } catch (e) { toast(e.message, 'bad'); beep('bad'); }
    finally { setBusy(false); }
  }

  const precio = resultado?.tarifa?.precio ?? 0;
  const tarifaSeleccionada = tarifas.find((t) => t.id === Number(tarifaId));
  const precioIngreso = tarifaSeleccionada?.precio ?? 0;
  const vuelto = medio === 'EFECTIVO' ? Math.max(0, (aCentavos(recibido) ?? 0) - precioIngreso) : 0;
  const botones = cfg.data?.config?.botonesCantidad ? Array.from({ length: cfg.data.config.botonesCantidad }, (_, i) => i + 1) : [1,2,3,4,5,6];

  return <><Topbar title="Operación" right={resultado ? <button className="btn ghost sm" onClick={limpiar}>Nueva operación <span className="kbd">Esc</span></button> : null} />
    <div className="content"><div className="op">
      <div>
        <div className="panel scan">
          <form onSubmit={escanear}>
            <div className="scan-label"><span className="scan-ready">Listo para escanear</span><span>Escanee el DNI o ingrese el número</span></div>
            <div className="scan-box"><input ref={scanRef} className="scan-input" value={dni} onChange={(e) => setDni(e.target.value)} placeholder="DNI..." autoComplete="off" /><button className="btn primary xl" disabled={busy}>Enter</button></div>
            <div className="scan-hint"><span>El lector envía Enter automáticamente</span><span>Escape limpia la operación</span></div>
          </form>
        </div>
        {resultado && !resultado.cobrado && !resultado.egresado && <div className="stage">
          <div className={`stage-h ${resultado.accion === 'INGRESO' ? 'ingreso' : 'egreso'}`}>
            <span className="tag">{resultado.accion}</span><span className="dni">{resultado.dni}</span>
            {resultado.historial && <span className="meta">{resultado.historial.visitas} visita(s)<br />{resultado.historial.ultima ? fechaHora(resultado.historial.ultima) : 'Primera visita'}</span>}
          </div>
          <div className="stage-b">
            {resultado.accion === 'INGRESO' ? <>
              <div className="grid g2">
                <label className="f">Nombre<input className="input" value={nombre} onChange={(e) => setNombre(e.target.value)} /></label>
                <label className="f">Apellido<input className="input" value={apellido} onChange={(e) => setApellido(e.target.value)} /></label>
              </div>
              <div className="spacer" /><h3>Cantidad de personas</h3><div className="spacer" />
              <div className="qty">{botones.map((n) => <button key={n} className={cantidad === n ? 'sel' : ''} onClick={() => setCantidad(n)}><small>{n <= 9 ? n : ''}</small>{n}</button>)}</div>
              <div className="qty-other"><span className="muted small">Otra cantidad</span><input className="input" type="number" min="1" value={cantidad} onChange={(e) => setCantidad(Number(e.target.value))} /></div>
              <div className="spacer" /><label className="f">Tarifa disponible
                <select className="input" value={tarifaId} onChange={(e) => setTarifaId(e.target.value)}>
                  <option value="">Seleccione una tarifa</option>
                  {tarifas.map((t) => <option key={t.id} value={t.id}>{t.nombre} — {$(t.precio)}</option>)}
                </select>
              </label>
              {tarifaSeleccionada && <><div className="spacer" /><div className="total"><span className="k">Total a cobrar</span><span className="v">{$(precioIngreso)}</span></div>
                <div className="pay"><button className={medio === 'EFECTIVO' ? 'sel' : ''} onClick={() => setMedio('EFECTIVO')}>Efectivo</button><button className={medio === 'TRANSFERENCIA' ? 'sel' : ''} onClick={() => setMedio('TRANSFERENCIA')}>Transferencia</button></div>
                {medio === 'EFECTIVO'
                  ? <><div className="spacer" /><label className="f">Monto recibido<MoneyInput value={recibido} onChange={setRecibido} /></label><div className="spacer" /><div className={`change ${(aCentavos(recibido) ?? 0) < precioIngreso ? 'bad' : ''}`}><span>Vuelto</span><span>{$(vuelto)}</span></div></>
                  : <><div className="spacer" /><label className="f">Referencia de transferencia<input className="input" value={referencia} onChange={(e) => setReferencia(e.target.value)} /></label><label className="check"><input type="checkbox" checked={verificada} onChange={(e) => setVerificada(e.target.checked)} />Confirmo que recibí y verifiqué el pago</label></>}
                <div className="spacer" /><button className="btn primary xl block" onClick={registrarIngreso} disabled={busy || !tarifaId}>Cobrar y registrar ingreso <span className="kbd">Enter</span></button>
              </>}
            </> : <>
              <div className="facts"><div><span className="k">Ingreso</span><div className="v">{hora(resultado.visita.ingreso)}</div></div><div><span className="k">Tiempo</span><div className="v">{resultado.visita.minutos} min</div></div><div><span className="k">Personas</span><div className="v">{resultado.visita.cantidad}</div></div></div>
              <div className="spacer" /><button className="btn primary xl block" onClick={confirmarEgreso} disabled={busy}>Confirmar egreso <span className="kbd">Enter</span></button>
            </>}
          </div>
        </div>}
        {resultado?.cobrado && <div className="result ok"><div className="icon">✓</div><div className="grow"><h2>Comprobante N° {nroOrden(resultado.cobrado.numero)}</h2><p>Ingreso y cobro registrados por {$(resultado.cobrado.importe)}</p></div><button className="btn" onClick={() => abrirImpresion(`/api/comprobantes/${resultado.cobrado.numero}.pdf`)}>Ver PDF</button><button className="btn" onClick={() => abrirImpresion(`/api/comprobantes/${resultado.cobrado.numero}.pdf?descargar=1`)}>Descargar PDF</button><button className="btn primary" onClick={limpiar}>Continuar</button></div>}
        {resultado?.egresado && <div className="result ok"><div className="icon">✓</div><div className="grow"><h2>Egreso registrado</h2><p>La salida fue registrada sin generar otro cobro.</p></div><button className="btn primary" onClick={limpiar}>Continuar</button></div>}
      </div>
      <aside className="panel"><div className="panel-h"><h2 className="grow">Dentro ahora</h2><Estado v={activas.data ? 'DENTRO' : null} /></div><div className="inside-list">{activas.data?.map((v) => <div className="inside-item" key={v.id} onClick={() => { setDni(v.dni); setResultado(null); escanear({ preventDefault: () => {} }, v.dni); }}><div className="n">{v.cantidad}</div><div><div className="d">{v.dni}</div><div className="muted small">Desde {hora(v.ingreso)}</div></div><div className="t">{v.minutos}<br />min</div></div>)}</div></aside>
    </div></div></>;
}

function Topbar({ title, right }) { return <header className="topbar"><div className="title grow">{title}</div>{right}</header>; }

function Caja() {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const caja = useAsync(() => api('/caja/actual'), []);
  const [saldo, setSaldo] = useState('');
  const [declarado, setDeclarado] = useState('');
  const [mov, setMov] = useState({ tipo: 'INGRESO', concepto: '', importe: '', signo: 1 });
  const [cerrarModal, setCerrarModal] = useState(false);
  const [movModal, setMovModal] = useState(false);
  async function abrir() { setLoading(true); try { await api('/caja/abrir', { method: 'POST', body: { saldoInicial: aCentavos(saldo) ?? 0 } }); await caja.recargar(); toast('Caja abierta', 'ok'); } catch(e){toast(e.message,'bad')} finally{setLoading(false)} }
  async function movimiento() { setLoading(true); try { await api('/caja/movimientos', { method: 'POST', body: { ...mov, importe: aCentavos(mov.importe), signo: mov.signo } }); await caja.recargar(); setMovModal(false); setMov({ tipo: 'INGRESO', concepto: '', importe: '', signo: 1 }); toast('Movimiento registrado','ok'); } catch(e){toast(e.message,'bad')} finally{setLoading(false)} }
  async function cerrar(forzar=false) { setLoading(true); try { await api('/caja/cerrar',{method:'POST',body:{declarado:aCentavos(declarado),observaciones:'',forzar}}); await caja.recargar(); setCerrarModal(false); toast('Caja cerrada','ok'); } catch(e){ if(e.codigo==='PENDIENTES') { if(confirm(`${e.data.avisos.map(a=>a.mensaje).join('\n')}\n\n¿Forzar cierre?`)) cerrar(true); } else toast(e.message,'bad'); } finally{setLoading(false)} }
  const c = caja.data?.caja;
  return <><Topbar title="Caja" /><div className="content">
    {c ? <><div className="grid g4"><Kpi label="Saldo inicial" value={$(c.resumen.saldoInicial)} /><Kpi label="Cobrado efectivo" value={$(c.resumen.efectivoCobrado)} /><Kpi label="Transferencias" value={$(c.resumen.transferenciasVerificadas)} /><Kpi label="Efectivo esperado" value={$(c.resumen.efectivoEsperado)} accent /></div>
      <div className="spacer" /><div className="panel"><div className="panel-h"><h2 className="grow">Movimientos</h2><button className="btn" onClick={()=>setMovModal(true)}>Nuevo movimiento</button><button className="btn danger" onClick={()=>setCerrarModal(true)}>Cerrar caja</button></div><Table headers={['Tipo','Concepto','Importe','Hora','Usuario']} rows={c.movimientos.map(m=>[m.tipo,m.concepto,<span className={m.importe<0?'neg':''}>{$(m.importe)}</span>,hora(m.fecha),m.usuario])}/></div>
    </> : <div className="panel" style={{maxWidth:480,margin:'40px auto'}}><div className="panel-h"><h2>Caja cerrada</h2></div><div className="panel-b stack"><label className="f">Saldo inicial<MoneyInput value={saldo} onChange={setSaldo} /></label><button className="btn primary xl block" onClick={abrir} disabled={loading}>Abrir caja</button></div></div>}
    {movModal&&<Modal titulo="Movimiento de caja" onClose={()=>setMovModal(false)} footer={<><button className="btn" onClick={()=>setMovModal(false)}>Cancelar</button><button className="btn primary" onClick={movimiento}>Registrar</button></>}><div className="stack"><label className="f">Tipo<select className="input" value={mov.tipo} onChange={e=>setMov({...mov,tipo:e.target.value})}><option>INGRESO</option><option>RETIRO</option><option>GASTO</option><option>AJUSTE</option></select></label>{mov.tipo==='AJUSTE'&&<label className="f">Sentido<select className="input" value={mov.signo} onChange={e=>setMov({...mov,signo:Number(e.target.value)})}><option value="1">Suma</option><option value="-1">Resta</option></select></label>}<label className="f">Concepto<input className="input" value={mov.concepto} onChange={e=>setMov({...mov,concepto:e.target.value})}/></label><label className="f">Importe<MoneyInput value={mov.importe} onChange={v=>setMov({...mov,importe:v})}/></label></div></Modal>}
    {cerrarModal&&<Modal titulo="Cerrar caja" onClose={()=>setCerrarModal(false)} footer={<><button className="btn" onClick={()=>setCerrarModal(false)}>Cancelar</button><button className="btn danger" onClick={()=>cerrar(false)}>Cerrar caja</button></>}><label className="f">Efectivo declarado<MoneyInput value={declarado} onChange={setDeclarado}/></label></Modal>}
  </div></>;
}

function Kpi({label,value,accent}) { return <div className={`kpi ${accent?'accent':''}`}><div className="lbl">{label}</div><div className="val">{value}</div></div>; }
function Table({headers,rows}) { return <div className="tbl-wrap"><table className="tbl"><thead><tr>{headers.map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{rows.length?rows.map((r,i)=><tr key={i}>{r.map((v,j)=><td key={j}>{v}</td>)}</tr>):<tr><td colSpan={headers.length} className="empty">Sin datos</td></tr>}</tbody></table></div>; }

function Dashboard() {
  const hoyIso = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const sumar = (d, dias) => { const x = new Date(d+'T12:00:00'); x.setDate(x.getDate()+dias); return hoyIso(x); };
  const inicioSemana = (d) => { const x = new Date(d+'T12:00:00'); const dia = (x.getDay()+6)%7; x.setDate(x.getDate()-dia); return hoyIso(x); };
  const inicioMes = (d) => `${d.slice(0,7)}-01`;
  const finMes = (d) => { const x = new Date(d+'T12:00:00'); x.setMonth(x.getMonth()+1,0); return hoyIso(x); };
  const hoyActual = hoyIso();
  const [rango,setRango] = useState({ desde: sumar(hoyActual,-29), hasta:hoyActual });
  const [comparar,setComparar] = useState(false);
  const [rangoComp,setRangoComp] = useState({ desde: sumar(rango.desde,-30), hasta: sumar(rango.desde,-1) });
  const [rapido,setRapido] = useState('30');
  const [orden,setOrden] = useState({ campo:'fecha', dir:-1 });
  const [pagina,setPagina] = useState(1);
  const [porPagina,setPorPagina] = useState(15);
  const [tabActividad,setTabActividad] = useState('resumen');
  const [diaSeleccionado,setDiaSeleccionado] = useState('');
  const query = qs({
    desde:rango.desde,
    hasta:rango.hasta,
    ...(comparar ? { compararDesde:rangoComp.desde, compararHasta:rangoComp.hasta } : {}),
  });
  const d = useAsync(() => api(`/dashboard${query}`), [query]);
  const data = d.data;
  const detalleDia = useAsync(
    () => diaSeleccionado ? api(`/dashboard/dia/${diaSeleccionado}`) : Promise.resolve(null),
    [diaSeleccionado],
  );
  const serieRef = useRef(null);
  const personasRef = useRef(null);
  const medioRef = useRef(null);
  const horaRef = useRef(null);

  function aplicarRapido(tipo) {
    setRapido(tipo);
    let desde=rango.desde, hasta=hoyActual;
    if(tipo==='hoy') { desde=hoyActual; hasta=hoyActual; }
    if(tipo==='ayer') { desde=sumar(hoyActual,-1); hasta=desde; }
    if(tipo==='7') desde=sumar(hoyActual,-6);
    if(tipo==='30') desde=sumar(hoyActual,-29);
    if(tipo==='semana') { desde=inicioSemana(hoyActual); hasta=hoyActual; }
    if(tipo==='semanaAnterior') { const actual=inicioSemana(hoyActual); desde=sumar(actual,-7); hasta=sumar(actual,-1); }
    if(tipo==='mes') { desde=inicioMes(hoyActual); hasta=hoyActual; }
    if(tipo==='mesAnterior') { const inicio=inicioMes(hoyActual); desde=inicioMes(sumar(inicio,-1)); hasta=finMes(sumar(inicio,-1)); }
    if(tipo==='ano') { desde=`${hoyActual.slice(0,4)}-01-01`; hasta=hoyActual; }
    if(tipo==='anoAnterior') { const ano=Number(hoyActual.slice(0,4))-1; desde=`${ano}-01-01`; hasta=`${ano}-12-31`; }
    setRango({desde,hasta});
    setRangoComp({desde:sumar(desde,-(Math.round((new Date(hasta+'T12:00:00')-new Date(desde+'T12:00:00'))/86400000)+1)),hasta:sumar(desde,-1)});
  }

  useEffect(() => {
    if (!data) return;
    const charts = [];
    if (serieRef.current) {
      const etiquetas = data.serie.map((r) => r.fecha.slice(5));
      const datasets = [{label:'Recaudación',data:data.serie.map(r=>r.total/100),borderColor:'#134e4a',backgroundColor:'rgba(19,78,74,.08)',tension:.25,fill:true}];
      if (data.comparado) datasets.push({label:'Período comparado',data:data.comparado.serie.map(r=>r.total/100),borderColor:'#9a5b00',borderDash:[5,5],tension:.25,fill:false});
      charts.push(new Chart(serieRef.current,{type:'line',data:{labels:etiquetas,datasets},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:true}},scales:{y:{beginAtZero:true}}}}));
    }
    if (personasRef.current) charts.push(new Chart(personasRef.current,{type:'bar',data:{labels:data.serie.map(r=>r.fecha.slice(5)),datasets:[{label:'Personas',data:data.serie.map(r=>r.personas),backgroundColor:'#1d6b65'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true}}}}));
    if (medioRef.current) charts.push(new Chart(medioRef.current,{type:'doughnut',data:{labels:['Efectivo','Transferencia'],datasets:[{data:[data.recaudacion.efectivo/100,data.recaudacion.transferencia/100],backgroundColor:['#134e4a','#c28a2f']}]},options:{responsive:true,maintainAspectRatio:false,cutout:'68%',plugins:{legend:{position:'bottom'}}}}));
    if (horaRef.current) charts.push(new Chart(horaRef.current,{type:'bar',data:{labels:data.porHora.map(r=>`${String(r.hora).padStart(2,'0')}:00`),datasets:[{label:'Ingresos',data:data.porHora.map(r=>r.grupos),backgroundColor:'#6a8f8a'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true}}}}));
    return () => charts.forEach(c=>c.destroy());
  }, [data]);

  function exportar(formato) {
    window.open(`/api/dashboard/exportar${query}&formato=${formato}`, '_blank');
  }

  function KpiComparado({label,value,indicador,accent,descripcion}) {
    const diff = indicador?.diferencia || 0;
    const pct = indicador?.porcentaje;
    const positive = diff > 0;
    return <div className={`kpi dashboard-kpi ${accent?'accent':''}`}>
      <div className="lbl" title={descripcion}>{label}</div>
      <div className="val">{value}</div>
      {comparar && <div className={`comparacion ${positive?'up':'down'}`}>
        <span>{diff === 0 ? 'Sin cambio' : `${positive?'▲':'▼'} ${typeof value==='string' && value.startsWith('$') ? $(Math.abs(diff)) : Math.abs(diff)}`}</span>
        {pct != null && <small>{diff === 0 ? '0% vs anterior' : `${positive ? '+' : '-'}${Math.abs(pct).toFixed(1)}% vs anterior`}</small>}
      </div>}
    </div>;
  }

  let filas = [...(data?.serie || [])];
  filas.sort((a,b) => {
    let av=a[orden.campo] ?? '', bv=b[orden.campo] ?? '';
    if(typeof av==='string') av=av.localeCompare(bv);
    else av=av-bv;
    return av*orden.dir;
  });
  useEffect(() => { setPagina(1); }, [query, porPagina, orden.campo, orden.dir]);
  const totalFilas = filas.length;
  const cantidadPagina = porPagina === 0 ? totalFilas : porPagina;
  const totalPaginas = cantidadPagina ? Math.max(1, Math.ceil(totalFilas/cantidadPagina)) : 1;
  const paginaActual = Math.min(pagina, totalPaginas);
  const filasPagina = porPagina === 0 ? filas : filas.slice((paginaActual-1)*porPagina, paginaActual*porPagina);

  return <><Topbar title="Dashboard" /><div className="content dashboard">
    <div className="dashboard-toolbar">
      <div className="dashboard-filtros">
        {[['hoy','Hoy'],['ayer','Ayer'],['7','Últimos 7 días'],['30','Últimos 30 días'],['semana','Esta semana'],['semanaAnterior','Semana anterior'],['mes','Este mes'],['mesAnterior','Mes anterior'],['ano','Este año'],['anoAnterior','Año anterior']].map(([v,t]) =>
          <button key={v} className={`btn sm ${rapido===v?'active':''}`} onClick={()=>aplicarRapido(v)}>{t}</button>)}
      </div>
      <div className="dashboard-periodo">
        <label className="f">Desde<input className="input" type="date" value={rango.desde} onChange={(e)=>{setRapido('personalizado');setRango({...rango,desde:e.target.value})}} /></label>
        <label className="f">Hasta<input className="input" type="date" value={rango.hasta} onChange={(e)=>{setRapido('personalizado');setRango({...rango,hasta:e.target.value})}} /></label>
        <label className="check"><input type="checkbox" checked={comparar} onChange={(e)=>setComparar(e.target.checked)} />Comparar período</label>
      </div>
      {comparar && <div className="dashboard-periodo comparado">
        <span>Período comparado</span>
        <label className="f">Desde<input className="input" type="date" value={rangoComp.desde} onChange={(e)=>setRangoComp({...rangoComp,desde:e.target.value})}/></label>
        <label className="f">Hasta<input className="input" type="date" value={rangoComp.hasta} onChange={(e)=>setRangoComp({...rangoComp,hasta:e.target.value})}/></label>
      </div>}
      <div className="dashboard-export">
        <button className="btn sm" onClick={()=>exportar('xlsx')}>Excel</button>
        <button className="btn sm" onClick={()=>exportar('csv')}>CSV</button>
        <button className="btn sm" onClick={()=>exportar('pdf')}>PDF</button>
      </div>
    </div>
    {d.cargando && <div className="empty">Actualizando información...</div>}
    {data && <>
      <section className="dashboard-section"><h2>Resumen general</h2><div className="grid g4">
        <KpiComparado label="Recaudación total" value={$(data.recaudacion.total)} indicador={data.indicadores.recaudacion} accent descripcion="Pagos confirmados en el período"/>
        <KpiComparado label="Personas ingresadas" value={data.ingresos.personas} indicador={data.indicadores.personas} descripcion="Suma de personas de todos los grupos"/>
        <KpiComparado label="Dentro ahora" value={data.dentro.personas} descripcion="Cantidad actual dentro del establecimiento"/>
        <KpiComparado label="Egresos" value={data.egresos.personas} indicador={data.indicadores.egresos} descripcion="Total de personas que finalizaron su visita"/>
      </div></section>
      <section className="dashboard-section"><h2>Rendimiento económico</h2><div className="grid g4">
        <KpiComparado label="Efectivo" value={$(data.recaudacion.efectivo)} indicador={data.indicadores.efectivo}/>
        <KpiComparado label="Transferencias" value={$(data.recaudacion.transferencia)} indicador={data.indicadores.transferencia}/>
        <KpiComparado label="Operaciones cobradas" value={data.recaudacion.operaciones} indicador={data.indicadores.operaciones}/>
        <KpiComparado label="Promedio por operación" value={$(data.indicadores.promedioOperacion.actual)} indicador={data.indicadores.promedioOperacion}/>
      </div></section>
      <section className="dashboard-grid">
        <div className="panel"><div className="panel-h"><h2>Evolución de la recaudación</h2></div><div className="panel-b chart-box"><canvas ref={serieRef}/></div></div>
        <div className="panel"><div className="panel-h"><h2>Medios de pago</h2></div><div className="panel-b payment-chart"><canvas ref={medioRef}/><div className="payment-legend"><div><span>Efectivo</span><b>{$(data.recaudacion.efectivo)}</b></div><div><span>Transferencia</span><b>{$(data.recaudacion.transferencia)}</b></div></div></div></div>
      </section>
      <section className="dashboard-grid">
        <div className="panel"><div className="panel-h"><h2>Personas ingresadas</h2></div><div className="panel-b chart-box"><canvas ref={personasRef}/></div></div>
        <div className="panel"><div className="panel-h"><h2>Horarios de mayor actividad</h2></div><div className="panel-b chart-box"><canvas ref={horaRef}/></div></div>
      </section>
      <section className="dashboard-grid">
        <div className="panel activity-panel">
          <div className="panel-h"><h2>Actividad por día</h2></div>
          <div className="activity-tabs tabs">
            <button className={tabActividad==='resumen'?'active':''} onClick={()=>setTabActividad('resumen')}>Resumen diario</button>
            <button className={tabActividad==='operaciones'?'active':''} onClick={()=>setTabActividad('operaciones')}>Operaciones</button>
            <button className={tabActividad==='tarifas'?'active':''} onClick={()=>setTabActividad('tarifas')}>Tarifas</button>
          </div>
          {tabActividad==='resumen' && <>
            <div className="activity-toolbar">
              <label className="f">Filas por página
                <select className="input" value={porPagina} onChange={(e)=>setPorPagina(Number(e.target.value))}>
                  <option value="7">7 días</option>
                  <option value="15">15 días</option>
                  <option value="30">30 días</option>
                  <option value="50">50 días</option>
                  <option value="0">Todos</option>
                </select>
              </label>
              <span>{totalFilas ? `${((paginaActual-1)*cantidadPagina)+1}-${Math.min(paginaActual*cantidadPagina,totalFilas)} de ${totalFilas}` : '0 días'}</span>
            </div>
            <div className="tbl-wrap">
              <table className="tbl"><thead><tr>
                {[['fecha','Fecha'],['operaciones','Operaciones'],['personas','Personas'],['efectivo','Efectivo'],['transferencia','Transferencia'],['total','Total']].map(([campo,t]) =>
                  <th key={campo} className={campo==='operaciones'||campo==='personas'||campo==='efectivo'||campo==='transferencia'||campo==='total'?'num':''}>
                    <button className="sort-button" onClick={()=>setOrden({campo,dir:orden.campo===campo?-orden.dir:1})}>{t}{orden.campo===campo?(orden.dir===1?' ▲':' ▼'):''}</button>
                  </th>)}
              </tr></thead><tbody>{filasPagina.map(r=>
                <tr key={r.fecha} className="click" onClick={()=>{setDiaSeleccionado(r.fecha);setTabActividad('operaciones')}}>
                  <td>{r.fecha.split('-').reverse().join('/')}</td><td className="num">{r.operaciones}</td><td className="num">{r.personas}</td>
                  <td className="num">{$(r.efectivo)}</td><td className="num">{$(r.transferencia)}</td><td className="num"><b>{$(r.total)}</b></td>
                </tr>)}</tbody></table>
            </div>
            {totalPaginas>1 && <div className="activity-pager">
              <button className="btn sm" disabled={paginaActual<=1} onClick={()=>setPagina(paginaActual-1)}>Anterior</button>
              <span>Página {paginaActual} de {totalPaginas}</span>
              <button className="btn sm" disabled={paginaActual>=totalPaginas} onClick={()=>setPagina(paginaActual+1)}>Siguiente</button>
            </div>}
          </>}
          {tabActividad==='operaciones' && <div className="activity-detail">
            <label className="f">Fecha seleccionada
              <input className="input" type="date" value={diaSeleccionado || rango.hasta} onChange={(e)=>setDiaSeleccionado(e.target.value)} />
            </label>
            {detalleDia.data && <>
              <div className="grid g4 activity-detail-kpis">
                <div className="kpi"><div className="lbl">Operaciones</div><div className="val">{detalleDia.data.resumen.operaciones}</div></div>
                <div className="kpi"><div className="lbl">Personas</div><div className="val">{detalleDia.data.resumen.personas}</div></div>
                <div className="kpi"><div className="lbl">Efectivo</div><div className="val">{$(detalleDia.data.resumen.efectivo)}</div></div>
                <div className="kpi"><div className="lbl">Total</div><div className="val">{$(detalleDia.data.resumen.recaudado)}</div></div>
              </div>
              <div className="tbl-wrap"><Table headers={['Comprobante','Hora','Titular','Personas','Tarifa','Medio','Importe','Operador']} rows={detalleDia.data.rows.map(r=>[
                nroOrden(r.numero),hora(r.fecha),r.titular,r.cantidad,r.tarifa||'—',r.medio,$(r.importe),r.operador,
              ])}/></div>
            </>}
          </div>}
          {tabActividad==='tarifas' && <div className="tbl-wrap">
            <Table headers={['Tarifa','Usos','Recaudado']} rows={(data.tarifasMasUsadas||[]).map(r=>[r.nombre,r.usos,$(r.total)])}/>
          </div>}
        </div>
        <div className="panel">
          <div className="panel-h"><h2>Información útil</h2></div>
          <div className="panel-b activity-summary">
            <div><span>Días con actividad</span><b>{filas.filter(r=>r.operaciones>0).length}</b></div>
            <div><span>Operaciones del período</span><b>{data.recaudacion.operaciones}</b></div>
            <div><span>Personas ingresadas</span><b>{data.ingresos.personas}</b></div>
            <div><span>Promedio diario</span><b>{$(filas.length ? Math.round(data.recaudacion.total/filas.length):0)}</b></div>
          </div>
        </div>
      </section>
    </>}
  </div></>;
}

function Historial() {
  const [tab, setTab] = useState('visitas');
  const [q, setQ] = useState({});
  const ops = useAsync(() => api('/operadores'), []);
  const data = useAsync(() => api(`/historial/${tab}${qs(q)}`), [tab, JSON.stringify(q)]);
  function descargar() {
    window.open(`/api/historial/${tab}?formato=csv&${qs(q).replace('?','')}`, '_blank');
  }
  const rowsVisitas = (data.data?.rows || []).map((r) => [
    r.ordenNumero ? nroOrden(r.ordenNumero) : '—',
    r.titular || '—',
    r.dni,
    r.cantidad,
    r.tarifaNombre || '—',
    r.importe != null ? $(r.importe) : '—',
    r.medio || '—',
    fechaHora(r.ingreso),
    r.egreso ? fechaHora(r.egreso) : '—',
    <Estado v={r.estado} />,
    r.ordenNumero ? <div className="row"><button className="btn sm" onClick={() => abrirImpresion(`/api/comprobantes/${r.ordenNumero}.pdf`)}>Ver PDF</button><button className="btn sm" onClick={() => abrirImpresion(`/api/comprobantes/${r.ordenNumero}.pdf?descargar=1`)}>Descargar</button></div> : '—',
  ]);
  const rowsOrdenes = (data.data?.rows || []).map((r) => [
    nroOrden(r.numero), fechaHora(r.fecha), r.dni, r.cantidad,
    $(r.importe), r.medio, <Estado v={r.estado} />,
  ]);
  return (
    <>
      <Topbar title="Historial" />
      <div className="content">
        <div className="panel">
          <div className="tabs">
            <button className={tab === 'visitas' ? 'active' : ''} onClick={() => setTab('visitas')}>Visitas</button>
            <button className={tab === 'ordenes' ? 'active' : ''} onClick={() => setTab('ordenes')}>Órdenes</button>
          </div>
          <div className="filters">
            <label className="f">Desde<input className="input" type="date" onChange={(e) => setQ({ ...q, desde: e.target.value })} /></label>
            <label className="f">Hasta<input className="input" type="date" onChange={(e) => setQ({ ...q, hasta: e.target.value })} /></label>
            <label className="f">Operador
              <select className="input" onChange={(e) => setQ({ ...q, operador: e.target.value })}>
                <option value="">Todos</option>
                {ops.data?.map((o) => <option key={o.id} value={o.id}>{o.nombre}</option>)}
              </select>
            </label>
            <button className="btn" onClick={() => data.recargar()}>Filtrar</button>
            <button className="btn primary" onClick={descargar}>Exportar CSV</button>
          </div>
          {tab === 'visitas'
            ? <Table headers={['Comprobante','Titular','DNI','Personas','Tarifa','Importe','Medio','Ingreso','Egreso','Estado','PDF']} rows={rowsVisitas} />
            : <Table headers={['Orden','Fecha','DNI','Personas','Importe','Medio','Estado']} rows={rowsOrdenes} />}
        </div>
      </div>
    </>
  );
}

function Admin() {
  const [tab,setTab]=useState('usuarios');
  const usuarios=useAsync(()=>api('/admin/usuarios'),[]);
  const tarifas=useAsync(()=>api('/tarifas'),[]);
  const config=useAsync(()=>api('/admin/config'),[]);
  const auditoria=useAsync(()=>api('/admin/auditoria'),[]);
  const backups=useAsync(()=>api('/admin/backups'),[]);
  const toast=useToast();
  const [nuevo,setNuevo]=useState({usuario:'',nombre:'',password:'',rol:'operador'});
  const [tramos,setTramos]=useState(null);
  const [nuevaTarifa,setNuevaTarifa]=useState({nombre:'',descripcion:'',cantidad:1,precio:'',activa:true});
  useEffect(()=>{if(tarifas.data&&!tramos)setTramos(tarifas.data.map(t=>({...t,precio:t.precio/100})))},[tarifas.data,tramos]);
  async function crear(e){e.preventDefault();try{await api('/admin/usuarios',{method:'POST',body:{...nuevo,password:nuevo.password}});setNuevo({usuario:'',nombre:'',password:'',rol:'operador'});usuarios.recargar();toast('Usuario creado','ok')}catch(e){toast(e.message,'bad')}}
  async function guardarTarifas(){try{await api('/tarifas',{method:'PUT',body:{tramos:tramos.map(t=>({desde:t.desde,precio:aCentavos(t.precio)}))}});tarifas.recargar();toast('Tarifas guardadas','ok')}catch(e){toast(e.message,'bad')}}
  async function crearTarifa(e) {
    e.preventDefault();
    try {
      await api('/tarifas', { method: 'POST', body: {
        nombre: nuevaTarifa.nombre,
        descripcion: nuevaTarifa.descripcion,
        cantidad: Number(nuevaTarifa.cantidad),
        precio: aCentavos(nuevaTarifa.precio),
        activa: nuevaTarifa.activa,
      } });
      setNuevaTarifa({ nombre:'', descripcion:'', cantidad:1, precio:'', activa:true });
      tarifas.recargar();
      toast('Tarifa creada', 'ok');
    } catch (e) { toast(e.message, 'bad'); }
  }
  async function actualizarTarifa(t, cambios) {
    const id = t.id ?? t.desde;
    try {
      if (!id) throw new Error('La tarifa no tiene un identificador válido');
      await api(`/tarifas/${id}`, { method: 'PATCH', body: cambios });
      tarifas.recargar();
      toast('Tarifa actualizada', 'ok');
    } catch (e) { toast(e.message, 'bad'); }
  }
  async function eliminarTarifa(t) {
    if (!confirm(`¿Eliminar o desactivar la tarifa "${t.nombre}"?`)) return;
    const id = t.id ?? t.desde;
    try {
      if (!id) throw new Error('La tarifa no tiene un identificador válido');
      await api(`/tarifas/${id}`, { method: 'DELETE' });
      tarifas.recargar();
      toast('Tarifa eliminada o desactivada', 'ok');
    } catch (e) { toast(e.message, 'bad'); }
  }
  async function backup(){try{await api('/admin/backups',{method:'POST'});backups.recargar();toast('Backup creado','ok')}catch(e){toast(e.message,'bad')}}
  return <><Topbar title="Administración" /><div className="content"><div className="panel"><div className="tabs">{['usuarios','tarifas','config','auditoria','backups'].map(t=><button key={t} className={tab===t?'active':''} onClick={()=>setTab(t)}>{t[0].toUpperCase()+t.slice(1)}</button>)}</div>
    {tab==='usuarios'&&<><div className="panel-b"><Table headers={['Usuario','Nombre','Rol','Estado']} rows={(usuarios.data||[]).map(u=>[u.usuario,u.nombre,u.rol,u.activo?'Activo':'Inactivo'])}/></div><form className="panel-b stack" onSubmit={crear}><h2>Crear usuario</h2><div className="grid g3"><label className="f">Usuario<input className="input" value={nuevo.usuario} onChange={e=>setNuevo({...nuevo,usuario:e.target.value})}/></label><label className="f">Nombre<input className="input" value={nuevo.nombre} onChange={e=>setNuevo({...nuevo,nombre:e.target.value})}/></label><label className="f">Contraseña<input className="input" type="password" value={nuevo.password} onChange={e=>setNuevo({...nuevo,password:e.target.value})}/></label></div><label className="f" style={{maxWidth:240}}>Rol<select className="input" value={nuevo.rol} onChange={e=>setNuevo({...nuevo,rol:e.target.value})}><option value="operador">Operador</option><option value="admin">Administrador</option></select></label><button className="btn primary" style={{alignSelf:'start'}}>Crear usuario</button></form></>}
    {tab==='tarifas'&&<div className="panel-b stack">
      <Table headers={['Nombre','Cantidad','Precio','Estado','Acciones']} rows={(tarifas.data||[]).map(t=>[
        <div><b>{t.nombre}</b><div className="muted small">{t.descripcion}</div></div>,
        t.cantidad,
        $(t.precio),
        t.activa?'Activa':'Inactiva',
        <div className="row"><button className="btn sm" onClick={()=>actualizarTarifa(t,{activa:!t.activa})}>{t.activa?'Desactivar':'Activar'}</button><button className="btn danger sm" onClick={()=>eliminarTarifa(t)}>Eliminar</button></div>,
      ])}/>
      <form className="stack" onSubmit={crearTarifa}>
        <h2>Crear tarifa</h2>
        <div className="grid g3">
          <label className="f">Nombre<input className="input" value={nuevaTarifa.nombre} onChange={e=>setNuevaTarifa({...nuevaTarifa,nombre:e.target.value})}/></label>
          <label className="f">Cantidad incluida<input className="input" type="number" min="1" value={nuevaTarifa.cantidad} onChange={e=>setNuevaTarifa({...nuevaTarifa,cantidad:Number(e.target.value)})}/></label>
          <label className="f">Precio total<MoneyInput value={nuevaTarifa.precio} onChange={v=>setNuevaTarifa({...nuevaTarifa,precio:v})}/></label>
        </div>
        <label className="f">Descripción<input className="input" value={nuevaTarifa.descripcion} onChange={e=>setNuevaTarifa({...nuevaTarifa,descripcion:e.target.value})}/></label>
        <label className="check"><input type="checkbox" checked={nuevaTarifa.activa} onChange={e=>setNuevaTarifa({...nuevaTarifa,activa:e.target.checked})}/>Tarifa activa</label>
        <button className="btn primary" style={{alignSelf:'start'}}>Crear tarifa</button>
      </form>
    </div>}
    {tab==='config'&&<ConfigPanel config={config.data} toast={toast}/>}
    {tab==='auditoria'&&<Table headers={['Fecha','Usuario','Acción','Entidad','Detalle']} rows={(auditoria.data?.rows||[]).map(r=>[fechaHora(r.fecha),r.usuario_nombre||'—',r.accion,r.entidad,r.detalle||''])}/>}
    {tab==='backups'&&<div className="panel-b"><button className="btn primary" onClick={backup}>Crear backup ahora</button><div className="spacer"/><Table headers={['Archivo','Bytes']} rows={(backups.data||[]).map(b=>[b.archivo,b.bytes])}/></div>}
  </div></div></>;
}

function ConfigPanel({config,toast}) {
  const [c,setC]=useState(config||{}); useEffect(()=>setC(config||{}),[config]);
  async function guardar(){try{await api('/admin/config',{method:'PUT',body:c});toast('Configuración guardada','ok')}catch(e){toast(e.message,'bad')}}
  if(!config)return null;
  return <div className="panel-b stack"><div className="grid g2"><label className="f">Establecimiento<input className="input" value={c.establecimiento_nombre||''} onChange={e=>setC({...c,establecimiento_nombre:e.target.value})}/></label><label className="f">Dirección<input className="input" value={c.establecimiento_direccion||''} onChange={e=>setC({...c,establecimiento_direccion:e.target.value})}/></label><label className="f">Máximo de personas<input className="input" type="number" value={c.max_personas||1} onChange={e=>setC({...c,max_personas:Number(e.target.value)})}/></label><label className="f">Retención backup (días)<input className="input" type="number" value={c.backup_retencion||30} onChange={e=>setC({...c,backup_retencion:Number(e.target.value)})}/></label></div><label className="check"><input type="checkbox" checked={!!c.caja_unica} onChange={e=>setC({...c,caja_unica:e.target.checked})}/>Caja única para todos los usuarios</label><button className="btn primary" style={{alignSelf:'start'}} onClick={guardar}>Guardar configuración</button></div>;
}

function PasswordChange({ onDone }) {
  const [actual,setActual]=useState(''); const [nueva,setNueva]=useState(''); const [error,setError]=useState('');
  async function enviar(e){e.preventDefault();try{await api('/auth/password',{method:'POST',body:{actual,nueva}});onDone()}catch(e){setError(e.message)}}
  return <Modal titulo="Cambiar contraseña" onClose={()=>{}}><form onSubmit={enviar} className="stack"><label className="f">Contraseña actual<input className="input" type="password" value={actual} onChange={e=>setActual(e.target.value)}/></label><label className="f">Nueva contraseña<input className="input" type="password" value={nueva} onChange={e=>setNueva(e.target.value)}/></label>{error&&<div className="field-err">{error}</div>}<button className="btn primary">Cambiar contraseña</button></form></Modal>;
}

function App() {
  const [yo,setYo]=useState(null); const [config,setConfig]=useState({ establecimiento: 'Establecimiento', direccion: '' });
  useEffect(() => {
    document.title = config.establecimiento
      ? `${config.establecimiento} - Control de Caja`
      : 'Control de Caja';
  }, [config.establecimiento]);
  useEffect(()=>{
    api('/auth/branding').then((branding) => setConfig(branding)).catch(() => {});
    api('/auth/me').then(r=>{setYo(r.usuario);setConfig(r.config)}).catch(e=>{if(e.status===401)setYo(null);else setYo(null)});
  },[]);
  setOnNoAuth(()=>setYo(null));
  async function logout(){await api('/auth/logout',{method:'POST'});setYo(null)}
  function loginSuccess(u, loginConfig) {
    setYo(u);
    if (loginConfig) setConfig(loginConfig);
    api('/auth/me').then((r) => setConfig(r.config));
  }
  if(!yo)return <BrowserRouter><Routes><Route path="*" element={<Login onLogin={loginSuccess} config={config} />}/></Routes></BrowserRouter>;
  if(yo.debeCambiarPass)return <BrowserRouter><PasswordChange onDone={()=>setYo({...yo,debeCambiarPass:false})}/></BrowserRouter>;
  return <BrowserRouter><ToastProvider><Shell yo={yo} config={config} onLogout={logout}/></ToastProvider></BrowserRouter>;
}

createRoot(document.getElementById('root')).render(<App />);
