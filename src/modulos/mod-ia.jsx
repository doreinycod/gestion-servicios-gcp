// MOD-IA · Asistente Virtual
// IA-P01 Chat del asistente · IA-P02 Historial y sugerencias
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/Layout'
import { Badge } from '../components/ui'
import { ListaPrestadores } from './mod-cat'
import { get, post } from '../lib/api'
import { useApi } from '../lib/useApi'
import { AsistenteReportes, TarjetaReporteIA, descargarCsv } from './mod-adm'
import { useSession } from '../components/session'
import { hace, money } from '../lib/format'

const ICONO_CAT = { Técnicos: '🔧', Profesionales: '💼', Hogar: '🏠' }
const EJEMPLOS = ['Se me fue la luz en la cocina y salta el breaker', 'Dame los 5 mejores servicios de luz', '¿Cuál es el mejor electricista?', '¿Cómo va mi solicitud?']

/**
 * Une mensajes y sugerencias guardados: cada sugerencia va con su respuesta (id_mensaje) o, en las
 * conversaciones anteriores, con la respuesta del asistente más cercana en el tiempo.
 */
function armarMensajes(datos) {
  const msgs = datos.mensajes.map((m) => ({ id: m.id_mensaje, de: m.emisor === 'Cliente' ? 'me' : 'bot', texto: m.contenido, fecha: m.fecha_envio, sugerencias: [], prestadores: m.prestadores || [] }))
  for (const g of datos.sugerencias) {
    let destino = g.id_mensaje ? msgs.find((m) => m.id === g.id_mensaje) : null
    if (!destino) {
      const t = new Date(g.fecha).getTime()
      for (const m of msgs) if (m.de === 'bot' && (!destino || Math.abs(new Date(m.fecha) - t) < Math.abs(new Date(destino.fecha) - t))) destino = m
    }
    destino?.sugerencias.push(g)
  }
  return msgs
}

/** Tarjeta de un prestador recomendado por el asistente. */
function PrestadorSugerido({ e, puesto, onPerfil, onSolicitar }) {
  return (
    <div className="suggest">
      <div className="suggest-icon">{puesto <= 3 ? ['🥇', '🥈', '🥉'][puesto - 1] : '👷'}</div>
      <div className="grow">
        <div className="semibold small">{e.nombre} {e.destacado && <Badge color="yellow">Destacado</Badge>}</div>
        <div className="xs muted">{e.especialidad} · {e.resenas ? `★ ${Number(e.calificacion).toFixed(1)} (${e.resenas} reseña${e.resenas === 1 ? '' : 's'})` : 'Sin reseñas aún'} · {e.completados} servicio{e.completados === 1 ? '' : 's'} completado{e.completados === 1 ? '' : 's'}</div>
        <div className="xs muted">{e.disponibilidad}{e.tarifa_hora ? ` · ${money(e.tarifa_hora)}/h` : ''}{e.zona ? ` · ${e.zona.split(',').slice(0, 3).join(', ')}${e.zona.split(',').length > 3 ? '…' : ''}` : ''}</div>
        <div className="row mt-8 wrap">
          <button className="btn btn-primary btn-sm" onClick={onSolicitar}>Solicitar con {e.nombre.split(' ')[0]}</button>
          <button className="btn btn-outline btn-sm" onClick={onPerfil}>Ver perfil</button>
        </div>
      </div>
    </div>
  )
}

/** Tarjeta del servicio sugerido por el asistente. */
function Sugerencia({ s, onSolicitar, onPrestadores }) {
  return (
    <div className="suggest">
      <div className="suggest-icon">{ICONO_CAT[s.categoria] || '🛠️'}</div>
      <div className="grow">
        <div className="semibold small">{s.nombre}</div>
        <div className="xs muted">{s.categoria} · {s.modalidad}{s.duracion_estimada ? ` · ${s.duracion_estimada}` : ''} · desde {money(s.precio_base)} + ITBIS</div>
        {s.descripcion_sugerencia && <div className="xs mt-8">{s.descripcion_sugerencia}</div>}
        {s.prestadores != null && <div className="xs muted">{s.prestadores ? `${s.prestadores} prestador${s.prestadores === 1 ? '' : 'es'}${s.calificacion ? ` · ★ ${s.calificacion} promedio` : ''}` : 'Asignación por disponibilidad'}</div>}
        <div className="row mt-8 wrap">
          <button className="btn btn-primary btn-sm" onClick={onSolicitar}>{s.aceptada ? '✓ Solicitar de nuevo' : 'Solicitar este servicio'}</button>
          <button className="btn btn-outline btn-sm" onClick={onPrestadores}>Ver prestadores</button>
        </div>
      </div>
    </div>
  )
}

// IA-P01 · Chat con el asistente virtual (Figura 48)
export function Asistente() {
  const navigate = useNavigate()
  const estado = useApi('/ia/estado')
  const convs = useApi('/ia/conversaciones')
  const [activa, setActiva] = useState(null)
  const [msgs, setMsgs] = useState([])
  const [txt, setTxt] = useState('')
  const [pensando, setPensando] = useState(false)
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState('')
  const [verPrestadores, setVerPrestadores] = useState(null)
  const fin = useRef(null)
  const entrada = useRef(null)

  useEffect(() => { fin.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }) }, [msgs, pensando])

  const nombre = estado.data?.nombre
  const saludo = { de: 'bot', texto: `¡Hola${nombre ? `, ${nombre}` : ''}! 👋 Soy el asistente de Directorio Servicios. Cuéntame qué necesitas y te sugiero el servicio adecuado, te recomiendo los mejores servicios y prestadores, o pregúntame sobre pagos, facturas o tus solicitudes.` }

  const abrir = async (id) => {
    setError('')
    setActiva(id)
    setCargando(true)
    try { setMsgs(armarMensajes(await get(`/ia/conversaciones/${id}/mensajes`))) } catch (e) { setError(e.message) } finally { setCargando(false) }
  }
  const nueva = () => { setActiva(null); setMsgs([]); setError(''); entrada.current?.focus() }
  // Abre el reporte en Consultas y reportes con los filtros que eligió la IA (con imprimir, lanza Guardar como PDF)
  const abrirReporte = (r, opciones = {}) => navigate(`/consultas?${new URLSearchParams({ r: r.id, ...(r.desde ? { desde: r.desde, hasta: r.hasta } : {}),
    ...(r.q ? { q: r.q } : {}), ...(r.estado ? { estado: r.estado } : {}), ...(opciones.imprimir ? { imprimir: '1' } : {}) })}`)

  const enviar = async (texto) => {
    const t = (texto ?? txt).trim()
    if (!t || pensando) return
    if (t.length > 1000) return setError('Escribe una pregunta de hasta 1,000 caracteres')
    setError('')
    setTxt('')
    setMsgs((m) => [...m, { de: 'me', texto: t }])
    setPensando(true)
    try {
      let id = activa
      if (!id) {
        id = (await post('/ia/conversaciones')).id_conversacion
        setActiva(id)
      }
      const r = await post(`/ia/conversaciones/${id}/mensajes`, { texto: t })
      setMsgs((m) => [...m, { de: 'bot', texto: r.respuesta, sugerencias: r.sugerencias || [], prestadores: r.prestadores || [], reportes: r.reportes || [] }])
      convs.recargar()
      // Si pidió el documento: Excel se descarga y PDF abre la vista de impresión del reporte
      const conDatos = (r.reportes || []).filter((x) => x.total_filas)
      for (const x of conDatos.filter((x) => x.formato === 'excel')) await descargarCsv(x.id, { desde: x.desde, hasta: x.hasta, q: x.q, estado: x.estado }, x.titulo).catch(() => {})
      const pdf = conDatos.find((x) => x.formato === 'pdf')
      if (pdf) abrirReporte(pdf, { imprimir: true })
    } catch (e) {
      setError(e.message)
      setMsgs((m) => m.slice(0, -1))
      setTxt(t)
    } finally {
      setPensando(false)
      entrada.current?.focus()
    }
  }

  const solicitar = async (s) => {
    try { await post(`/ia/sugerencias/${s.id_sugerencia}/aceptar`) } catch { /* la sugerencia solo se marca para estadísticas */ }
    navigate(`/solicitudes/nueva?servicio=${s.id_servicio}`)
  }

  const modo = estado.data?.modo
  return (
    <Page crumb="Inicio · Asistente IA" title="Asistente virtual">
      <div className="split" style={{ gridTemplateColumns: '250px minmax(0,1fr)' }}>
        <div className="card">
          <button className="btn btn-primary btn-block" onClick={nueva}>＋ Nueva conversación</button>
          <div className="label mt-16 mb-8">Recientes</div>
          {(convs.data || []).map((c) => (
            <button key={c.id_conversacion} className="nav-item small" title={c.titulo || ''}
              style={{ color: 'var(--text)', background: activa === c.id_conversacion ? 'var(--green-100)' : 'none', display: 'block', textAlign: 'left', width: '100%' }}
              onClick={() => abrir(c.id_conversacion)}>
              💬 {c.titulo ? (c.titulo.length > 28 ? `${c.titulo.slice(0, 28)}…` : c.titulo) : 'Conversación sin mensajes'}
              <div className="xs muted" style={{ paddingLeft: 20 }}>{hace(c.fecha_inicio)}</div>
            </button>
          ))}
          {convs.data && !convs.data.length && <div className="xs muted">Aún no tienes conversaciones.</div>}
          <div className="alert alert-info xs mt-16">El asistente responde con base en el catálogo vigente y tus solicitudes. No realiza pagos ni cambia el estado de tus solicitudes.</div>
        </div>

        <div className="card flush chat">
          <div className="row between" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
            <div className="row">
              <div className="avatar" style={{ background: 'var(--green-600)' }}>🤖</div>
              <div>
                <div className="semibold">Asistente Directorio</div>
                <div className="xs green">● {pensando ? 'Escribiendo…' : 'En línea'}{activa ? ` · conversación #${activa}` : ''}</div>
              </div>
            </div>
            {modo === 'local' && <Badge color="yellow" >Modo básico</Badge>}
          </div>
          <div className="chat-body">
            <div className="msg bot">{saludo.texto}</div>
            {!msgs.length && !cargando && (
              <div className="row wrap" style={{ gap: 6 }}>
                {EJEMPLOS.map((e) => <button key={e} className="chip" onClick={() => enviar(e)}>{e}</button>)}
              </div>
            )}
            {cargando && <div className="xs muted">Cargando conversación…</div>}
            {msgs.map((m, i) => (
              <div key={m.id || i} className={`msg ${m.de}`} style={{ whiteSpace: 'pre-wrap' }}>
                {m.texto}
                {m.reportes?.map((r, j) => <TarjetaReporteIA key={`r${j}`} r={r} onAbrir={abrirReporte} />)}
                {m.sugerencias?.map((g) => <Sugerencia key={g.id_sugerencia} s={g} onSolicitar={() => solicitar(g)} onPrestadores={() => setVerPrestadores(g)} />)}
                {m.prestadores?.map((e, i) => (
                  <PrestadorSugerido key={e.id_empleado} e={e} puesto={i + 1} onPerfil={() => navigate(`/prestadores/${e.id_empleado}`)}
                    onSolicitar={() => navigate(`/solicitudes/nueva?prestador=${e.id_empleado}${m.sugerencias?.[0] ? `&servicio=${m.sugerencias[0].id_servicio}` : ''}`)} />
                ))}
              </div>
            ))}
            {pensando && <div className="msg bot muted"><span className="typing">●●●</span></div>}
            <div ref={fin} />
          </div>
          {error && <div className="alert alert-err small" style={{ margin: '0 12px 8px' }}>{error}</div>}
          <form className="row" style={{ padding: 12, borderTop: '1px solid var(--border)' }} onSubmit={(e) => { e.preventDefault(); enviar() }}>
            <input ref={entrada} className="input" placeholder="Escribe tu pregunta..." value={txt} onChange={(e) => setTxt(e.target.value)} maxLength={1000} disabled={pensando} autoFocus />
            <button className="btn btn-primary" disabled={pensando || !txt.trim()}>{pensando ? '…' : 'Enviar'}</button>
          </form>
          {modo === 'local' && <div className="xs muted" style={{ padding: '0 12px 10px' }}>Modo básico: responde por palabras clave. Con la clave de Gemini configurada entiende cualquier pregunta.</div>}
        </div>
      </div>
      {verPrestadores && <ListaPrestadores servicio={verPrestadores} onClose={() => setVerPrestadores(null)} />}
    </Page>
  )
}

// IA-P03 · Asistente IA del administrador y del prestador: chat para pedir reportes y ayuda con el sistema.
// (Las conversaciones de los clientes se consultan en Consultas y reportes → Conversaciones del asistente IA.)
export function AsistenteGestion() {
  const navigate = useNavigate()
  const { usuario } = useSession()
  const rol = usuario?.rol
  const base = rol === 'Administrador' ? '/admin/reportes' : '/prestador/reportes'
  // "Abrir reporte completo": abre Consultas y reportes con el reporte y los filtros que eligió la IA
  // con { imprimir: true } la pantalla de reportes abre la vista de impresión (Guardar como PDF) al cargar
  const abrir = (r, opciones = {}) => navigate(`${base}?${new URLSearchParams({ r: r.id, ...(r.desde ? { desde: r.desde, hasta: r.hasta } : {}),
    ...(r.q ? { q: r.q } : {}), ...(r.estado ? { estado: r.estado } : {}), ...(opciones.imprimir ? { imprimir: '1' } : {}) })}`)
  return (
    <Page crumb={`${rol === 'Administrador' ? 'Administración' : 'Prestador'} · Asistente IA`} title="Asistente virtual">
      <div className="split" style={{ gridTemplateColumns: 'minmax(0,1fr) 260px' }}>
        <AsistenteReportes rol={rol} onAbrir={abrir} completo />
        <div className="card small" style={{ alignSelf: 'flex-start' }}>
          <div className="card-title">¿Qué puedo pedirle?</div>
          <ul style={{ paddingLeft: 18, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <li><b>Cifras y reportes</b> con los datos reales del sistema, por periodo, búsqueda o estado.</li>
            <li><b>Comparaciones</b>: "este mes contra el pasado".</li>
            <li><b>Cómo hacer algo</b> en la plataforma, paso a paso.</li>
          </ul>
          <div className="alert alert-info xs mt-12">
            La IA solo usa las consultas y reportes de tu rol, con tus permisos. No cambia datos: para aprobar, conciliar o facturar te indica la pantalla.
          </div>
          <button className="btn btn-outline btn-sm btn-block mt-12" onClick={() => navigate(base)}>📈 Ir a Consultas y reportes</button>
        </div>
      </div>
    </Page>
  )
}
