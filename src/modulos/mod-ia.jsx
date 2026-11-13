// MOD-IA · Asistente Virtual
// IA-P01 Chat del asistente · IA-P02 Historial y sugerencias
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/Layout'
import { Badge, Kpi, Modal } from '../components/ui'
import { ListaPrestadores } from './mod-cat'
import { get, post } from '../lib/api'
import { useApi } from '../lib/useApi'
import { fecha, fechaHora, hace, money, num0 } from '../lib/format'

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
      setMsgs((m) => [...m, { de: 'bot', texto: r.respuesta, sugerencias: r.sugerencias || [], prestadores: r.prestadores || [] }])
      convs.recargar()
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

// IA-P02 · Historial y sugerencias del asistente
export function AsistenteAdmin() {
  const d = useApi('/admin/ia')
  const [ver, setVer] = useState(null)
  const [detalle, setDetalle] = useState(null)
  const abrir = async (id) => {
    setVer(id)
    setDetalle(null)
    try { setDetalle(await get(`/admin/ia/conversaciones/${id}`)) } catch (e) { setDetalle({ error: e.message }) }
  }
  const k = d.data?.kpis
  const pctAceptadas = k?.sugerencias ? Math.round((k.aceptadas / k.sugerencias) * 100) : 0
  return (
    <Page crumb="Administración · Asistente IA" title="Historial y sugerencias IA">
      {d.data?.modo === 'local' && (
        <div className="alert alert-warn mb-16">El asistente está en <b>modo básico</b> (respuestas por palabras clave). Configure <b>GEMINI_API_KEY</b> en backend/.env para usar Gemini.</div>
      )}
      {d.error && <div className="alert alert-err mb-16">{d.error.message}</div>}
      <div className="grid g-4 mb-16">
        <Kpi label="Conversaciones (mes)" value={k ? num0(k.conversaciones_mes) : '—'} />
        <Kpi label="Sugerencias emitidas" value={k ? num0(k.sugerencias) : '—'} />
        <Kpi label="Sugerencias aceptadas" value={k ? `${pctAceptadas}%` : '—'} foot={k ? `${num0(k.aceptadas)} solicitudes iniciadas` : null} up />
        <Kpi label="Tokens consumidos" value={k ? num0(k.tokens) : '—'} foot={{ gemini: 'Google Gemini', claude: 'Claude (Anthropic)' }[d.data?.modo] || 'Modo básico (0 tokens)'} />
      </div>
      <div className="card">
        <div className="card-title">Conversaciones recientes</div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>#</th><th>Cliente</th><th>Primera pregunta</th><th>Servicio sugerido</th><th>Aceptada</th><th className="num">Tokens</th><th>Estado</th><th /></tr></thead>
            <tbody>
              {(d.data?.recientes || []).map((c) => (
                <tr key={c.id_conversacion}>
                  <td>{c.id_conversacion}</td><td>{c.cliente}<div className="xs muted">{fecha(c.fecha_inicio)}</div></td>
                  <td>{c.primera_pregunta || <span className="muted">—</span>}</td><td>{c.servicio_sugerido || '—'}</td>
                  <td>{c.servicio_sugerido ? <Badge color={c.aceptada ? 'green' : 'gray'}>{c.aceptada ? 'Sí' : 'No'}</Badge> : '—'}</td>
                  <td className="num">{num0(c.tokens)}</td><td><Badge>{c.estado}</Badge></td>
                  <td><button className="btn btn-outline btn-sm" onClick={() => abrir(c.id_conversacion)}>Ver</button></td>
                </tr>
              ))}
              {d.data && !d.data.recientes.length && <tr><td colSpan={8} className="center muted">Aún no hay conversaciones.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {ver && (
        <Modal titulo={`Conversación #${ver}${detalle?.cliente ? ` · ${detalle.cliente}` : ''}`} onClose={() => setVer(null)} ancho={680}>
          {!detalle ? <div className="muted small">Cargando…</div> : detalle.error ? <div className="alert alert-err">{detalle.error}</div> : (
            <div className="col" style={{ gap: 8, maxHeight: '60vh', overflowY: 'auto' }}>
              {detalle.mensajes.map((m) => (
                <div key={m.id_mensaje} className={`msg ${m.emisor === 'Cliente' ? 'me' : 'bot'}`} style={{ whiteSpace: 'pre-wrap', maxWidth: '85%' }}>
                  {m.contenido}
                  <div className="xs" style={{ opacity: 0.7, marginTop: 4 }}>{fechaHora(m.fecha_envio)}{m.tokens ? ` · ${num0(m.tokens)} tokens` : ''}</div>
                </div>
              ))}
              {detalle.sugerencias.length > 0 && (
                <div className="small mt-8"><b>Sugerencias:</b> {detalle.sugerencias.map((g) => `${g.nombre}${g.aceptada ? ' (aceptada)' : ''}`).join(' · ')}</div>
              )}
            </div>
          )}
        </Modal>
      )}
    </Page>
  )
}
