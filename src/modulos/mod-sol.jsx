// MOD-SOL · Gestión de Solicitudes
// SOL-P01 Nueva solicitud · SOL-P02 Seguimiento · SOL-P03 Mis solicitudes · SOL-P04 Panel del prestador (asignaciones, agenda, calificaciones, perfil) · Solicitudes (administrador)
import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams, useParams } from 'react-router-dom'
import { Page } from '../components/Layout'
import { Stepper, Avatar, Badge, Field, Modal, Chips, Kpi, Stars } from '../components/ui'
import { resenas, solicitudesAdmin } from '../data/mock'
import { money, num, isoDia, dia, diaDeFecha, diaSemana, fechaHora, hace, hora12, manana, restante } from '../lib/format'
import { ReportarEfectivo } from './mod-pag'
import { patch, post } from '../lib/api'
import { useApi } from '../lib/useApi'
import { useSession } from '../components/session'
import { entero, decimal, soloTextoSinNumeros, soloDecimal } from '../lib/filtros'

// SOL-P01 · Nueva solicitud, asistente de 4 pasos (Figuras 37 y 38)
const PASOS = ['Servicio', 'Detalles y fecha', 'Prestador', 'Confirmar']

export function NuevaSolicitud() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { usuario } = useSession()
  const catalogo = useApi('/catalogo/servicios')
  const servicios = catalogo.data || []

  const [paso, setPaso] = useState(params.get('servicio') ? 1 : 0)
  const [lineas, setLineas] = useState([{ id_servicio: Number(params.get('servicio')) || '', cantidad: 1 }])
  const [desc, setDesc] = useState('')
  const [modalidad, setModalidad] = useState('En sitio')
  const [dir, setDir] = useState(usuario?.direccion || '')
  const [fecha, setFecha] = useState(() => params.get('fecha') || manana())
  const [horaP, setHoraP] = useState(params.get('hora') || '10:00')
  const [prest, setPrest] = useState(params.get('prestador') ? Number(params.get('prestador')) : 'auto')
  const [acepta, setAcepta] = useState(false)
  const [error, setError] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [registrada, setRegistrada] = useState(null)
  const [cot, setCot] = useState(null)

  const elegidos = lineas.map((l) => servicios.find((s) => s.id_servicio === Number(l.id_servicio))).filter(Boolean)
  const principal = elegidos[0]
  const permiteSitio = elegidos.length > 0 && elegidos.every((s) => s.modalidad !== 'Remoto')
  const permiteRemoto = elegidos.length > 0 && elegidos.every((s) => s.modalidad !== 'En sitio')
  const prestadores = useApi(principal ? `/catalogo/prestadores?servicio=${principal.id_servicio}` : null)
  const p = (prestadores.data || []).find((x) => x.id_empleado === prest)
  const clave = JSON.stringify(lineas)

  // v_totalPagar estimado (subtotal − descuento de plan + ITBIS 18 %), calculado por el servidor
  useEffect(() => {
    const validas = JSON.parse(clave).filter((l) => l.id_servicio)
    if (!validas.length) return
    let vivo = true
    post('/solicitudes/cotizar', { servicios: validas }).then((r) => vivo && setCot(r)).catch(() => vivo && setCot(null))
    return () => { vivo = false }
  }, [clave])

  const setLinea = (i, k, v) => setLineas(lineas.map((l, j) => (j === i ? { ...l, [k]: v } : l)))
  const modalidadEfectiva = permiteSitio && (modalidad === 'En sitio' || !permiteRemoto) ? 'En sitio' : 'Remoto'

  const siguiente = () => {
    setError('')
    if (paso === 0 && (!elegidos.length || elegidos.length !== lineas.length)) return setError('Seleccione el servicio.')
    if (paso === 1) {
      if (fecha < isoDia()) return setError('Seleccione una fecha válida (igual o posterior a hoy).')
      if (modalidadEfectiva === 'En sitio' && dir.trim().length < 10) return setError('Indique la dirección del servicio.')
    }
    setPaso(paso + 1)
  }

  const solicitar = async () => {
    setError('')
    setEnviando(true)
    try {
      const r = await post('/solicitudes', {
        servicios: lineas.map((l) => ({ id_servicio: Number(l.id_servicio), cantidad: Number(l.cantidad) })),
        descripcion_problema: desc, modalidad: modalidadEfectiva, direccion_servicio: modalidadEfectiva === 'En sitio' ? dir : null,
        fecha_preferida: fecha, hora_preferida: horaP, id_empleado: prest === 'auto' ? null : prest, acepta_politica: acepta,
      })
      setRegistrada(r)
    } catch (e) {
      setError(e.message)
    } finally {
      setEnviando(false)
    }
  }

  return (
    <Page crumb="Inicio · Nueva solicitud" title="Nueva solicitud de servicio">
      <Stepper pasos={PASOS} actual={paso} />
      <div className="split">
        <div className="col" style={{ gap: 16 }}>
          {paso === 0 && (
            <div className="card">
              <div className="card-title">Paso 1 · Servicio</div>
              {lineas.map((l, i) => (
                <div key={i} className="form-grid mb-12">
                  <Field label={i === 0 ? 'Servicio' : `Servicio ${i + 1}`}>
                    <select className="select" value={l.id_servicio} onChange={(e) => setLinea(i, 'id_servicio', e.target.value)}>
                      <option value="">{catalogo.cargando ? 'Cargando…' : 'Seleccione…'}</option>
                      {servicios.map((s) => <option key={s.id_servicio} value={s.id_servicio}>{s.nombre} · {money(s.precio_base)}</option>)}
                    </select>
                  </Field>
                  <Field label="Cantidad / horas" hint="Entero entre 1 y 99.">
                    <div className="row">
                      <input className="input" inputMode="numeric" value={l.cantidad} onChange={(e) => setLinea(i, 'cantidad', Math.max(1, Math.min(99, +entero(e.target.value, 2) || 1)))} />
                      {i > 0 && <button className="btn btn-danger btn-sm" onClick={() => setLineas(lineas.filter((_, j) => j !== i))}>✕</button>}
                    </div>
                  </Field>
                </div>
              ))}
              {lineas.length < 5 && <button className="link-btn small" onClick={() => setLineas([...lineas, { id_servicio: '', cantidad: 1 }])}>＋ Agregar otro servicio a la misma visita</button>}
            </div>
          )}

          {paso === 1 && (
            <div className="card col">
              <div className="alert alert-ok">
                <b>Paso 1 completado:</b> {elegidos.map((s, i) => `${s.nombre} × ${lineas[i].cantidad}`).join(', ')}. <button className="link-btn" onClick={() => setPaso(0)}>＋ Agregar servicio</button>
              </div>
              <Field label="Describe el problema o la necesidad">
                <textarea className="textarea" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Ej. Desde anoche no funcionan los tomacorrientes de la cocina…" />
              </Field>
              <div>
                <div className="label mb-8">Modalidad</div>
                <div className="grid g-2" style={{ gap: 10 }}>
                  <label className={`option-card ${!permiteSitio ? 'disabled' : ''} ${modalidadEfectiva === 'En sitio' ? 'selected' : ''}`}>
                    <input type="radio" disabled={!permiteSitio} checked={modalidadEfectiva === 'En sitio'} onChange={() => setModalidad('En sitio')} /> En sitio (a domicilio)
                    {!permiteSitio && <span className="muted"> (no disponible)</span>}
                  </label>
                  <label className={`option-card ${!permiteRemoto ? 'disabled' : ''} ${modalidadEfectiva === 'Remoto' ? 'selected' : ''}`}>
                    <input type="radio" disabled={!permiteRemoto} checked={modalidadEfectiva === 'Remoto'} onChange={() => setModalidad('Remoto')} />
                    Remoto / virtual {!permiteRemoto && <span className="muted">(no disponible para este servicio)</span>}
                  </label>
                </div>
              </div>
              {modalidadEfectiva === 'En sitio' && (
                <>
                  <Field label="Dirección del servicio" hint="Incluye el sector (ej. Los Jardines, Villa Olga) para asignar un prestador de tu zona.">
                    <input className="input" value={dir} onChange={(e) => setDir(e.target.value)} />
                  </Field>
                  <div className="map">🗺️ Vista previa del mapa</div>
                </>
              )}
              <div className="form-grid">
                <Field label="Fecha preferida" hint="Debe ser igual o posterior a hoy."><input className="input" type="date" min={isoDia()} value={fecha} onChange={(e) => setFecha(e.target.value)} /></Field>
                <Field label="Hora preferida">
                  <select className="select" value={horaP} onChange={(e) => setHoraP(e.target.value)}>
                    {['08:00', '10:00', '14:00', '16:00'].map((h) => <option key={h} value={h}>{hora12(h)}</option>)}
                  </select>
                </Field>
              </div>
            </div>
          )}

          {paso >= 2 && (
            <div className="card">
              <div className="card-title">Paso 3 · ¿Quién realizará el servicio?</div>
              <div className="col" style={{ gap: 8 }}>
                {(prestadores.data || []).map((x) => (
                  <label key={x.id_empleado} className={`option-card ${prest === x.id_empleado ? 'selected' : ''}`} style={{ alignItems: 'center' }}>
                    <input type="radio" checked={prest === x.id_empleado} onChange={() => setPrest(x.id_empleado)} />
                    <Avatar ini={`${x.nombre[0]}${x.apellido[0]}`} size="sm" />
                    <div className="grow small"><b>{x.nombre} {x.apellido}</b> {x.destacado ? <Badge color="yellow">Destacado</Badge> : null} <span className="muted">· ★{x.calificacion_promedio} · RD${num(x.tarifa_hora)}/h · {x.estado_disponibilidad}</span></div>
                    {params.get('prestador') && Number(params.get('prestador')) === x.id_empleado && <Badge>Elegido</Badge>}
                  </label>
                ))}
                <label className={`option-card ${prest === 'auto' ? 'selected' : ''}`} style={{ alignItems: 'center' }}>
                  <input type="radio" checked={prest === 'auto'} onChange={() => setPrest('auto')} />
                  <span style={{ fontSize: 18 }}>⚡</span>
                  <div><div className="semibold small">Asignar automáticamente</div><div className="xs muted">El sistema elige un prestador aprobado, disponible, de tu zona y con mejor calificación.</div></div>
                </label>
              </div>
            </div>
          )}

          {paso === 3 && (
            <div className="card">
              <div className="card-title">Paso 4 · Confirma tu solicitud</div>
              <div className="kv">
                <div>Servicio</div><div className="semibold">{elegidos.map((s, i) => `${s.nombre} × ${lineas[i].cantidad}`).join(', ')}</div>
                <div>Descripción</div><div>{desc || '—'}</div>
                <div>Modalidad / Dirección</div><div>{modalidadEfectiva}{modalidadEfectiva === 'En sitio' ? ` · ${dir}` : ''}</div>
                <div>Fecha y hora</div><div>{dia(fecha)} · {hora12(horaP)}</div>
                <div>Prestador</div><div>{p ? `${p.nombre} ${p.apellido} (asignación manual)` : 'Asignación automática'}</div>
                <div>Pago</div><div><b>50 % de anticipo</b> cuando el prestador acepte y <b>50 % al finalizar</b> el servicio (PayPal, tarjeta, transferencia o efectivo)</div>
              </div>
              <label className="check mt-12"><input type="checkbox" checked={acepta} onChange={(e) => setAcepta(e.target.checked)} /> Acepto la política de cancelación (sin costo hasta 12 h antes).</label>
            </div>
          )}

          {error && <div className="alert alert-err">{error}</div>}
          {!registrada && (
            <div className="row end">
              <button className="btn btn-ghost" onClick={() => navigate('/catalogo')}>Cancelar <span className="kbd">Esc</span></button>
              <button className="btn btn-outline" disabled={paso === 0} onClick={() => setPaso(paso - 1)}>← Anterior</button>
              {paso < 3
                ? <button className="btn btn-primary" onClick={siguiente}>Siguiente</button>
                : <button className="btn btn-primary" disabled={!acepta || enviando} onClick={solicitar}>{enviando ? 'Registrando…' : 'Solicitar servicio'}</button>}
            </div>
          )}
        </div>

        <div className="col" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-title">Resumen de la solicitud</div>
            {principal ? (
              <div className="row">
                <div className="suggest-icon">{principal.icono || '🛠️'}</div>
                <div><div className="semibold small">{principal.nombre}</div><div className="xs muted">{principal.categoria} · {modalidadEfectiva} · {principal.duracion_estimada ? `${principal.duracion_estimada / 60} h` : ''}</div></div>
              </div>
            ) : <div className="small muted">Selecciona un servicio.</div>}
            <div className="row mt-12">
              <Avatar ini={p ? `${p.nombre[0]}${p.apellido[0]}` : '⚡'} size="sm" />
              <div><div className="semibold small">{p ? `${p.nombre} ${p.apellido}` : 'Asignación automática'}</div><div className="xs muted">{p ? `★ ${p.calificacion_promedio} · Elegido por ti` : 'Se asigna al registrar'}</div></div>
            </div>
            <div className="divider" />
            {cot && (
              <div className="small col" style={{ gap: 4 }}>
                {cot.detalle.map((l, i) => <div key={i} className="row between"><span>{l.nombre} ({l.cantidad} × RD${num(l.precio_unitario)})</span><span>{num(l.subtotal)}</span></div>)}
                <div className="row between"><span>Descuento {cot.plan ? `plan ${cot.plan}` : 'de plan'}</span><span>− {num(cot.descuento)}</span></div>
                <div className="row between"><span>ITBIS 18%</span><span>{num(cot.itbis)}</span></div>
                <div className="row between bold" style={{ fontSize: 15, marginTop: 4 }}><span>Total estimado</span><span>{money(cot.total)}</span></div>
              </div>
            )}
            {cot && cot.total > 0 && (
              <div className="small col mt-8" style={{ gap: 2, background: 'var(--green-50)', borderRadius: 8, padding: '8px 10px' }}>
                <div className="row between"><span>Anticipo al aceptar (50 %)</span><b>≈ {money(cot.total / 2)}</b></div>
                <div className="row between"><span>Saldo al finalizar (50 %)</span><b>≈ {money(cot.total / 2)}</b></div>
              </div>
            )}
            <div className="xs muted mt-8">Los materiales que agregue el prestador se suman al saldo. Comprobante: <b className="green">{usuario?.tipo_cliente === 'Empresa' ? 'e31 Crédito Fiscal' : 'e32 Consumo'}</b></div>
          </div>

          {registrada && (
            <div className="card center" style={{ border: '2px solid var(--green-800)' }}>
              <div style={{ fontSize: 34 }}>✅</div>
              <div className="bold">¡Solicitud registrada!</div>
              <div className="small muted">Estado <Badge>Pendiente</Badge></div>
              <div className="card mt-12" style={{ background: 'var(--green-50)', padding: 10 }}>
                <div className="xs muted">Código de seguimiento</div>
                <div className="bold mono" style={{ fontSize: 18, letterSpacing: 2 }}>{registrada.codigo_seguimiento}</div>
              </div>
              <div className="xs muted mt-8">
                {registrada.prestador_asignado ? `El prestador tiene ${registrada.plazo_respuesta_h} h para aceptar.` : 'No hay prestador disponible ahora; administración lo asignará manualmente.'}
              </div>
              <button className="btn btn-primary btn-block mt-12" onClick={() => navigate(`/seguimiento/${registrada.codigo_seguimiento}`)}>Ver seguimiento</button>
            </div>
          )}
        </div>
      </div>
    </Page>
  )
}

// SOL-P02 · Seguimiento de la solicitud en tiempo real (Figura 39)
const ETAPAS = ['Pendiente', 'Aceptado', 'En proceso', 'Completado', 'Pagado', 'Facturado']

export function Seguimiento() {
  const navigate = useNavigate()
  const { codigo } = useParams()
  const s = useApi(`/solicitudes/seguimiento/${codigo}`)
  const [estrellas, setEstrellas] = useState(0)
  const [comentario, setComentario] = useState('')
  const [cancelar, setCancelar] = useState(false)
  const [motivo, setMotivo] = useState('')
  const [error, setError] = useState('')
  const d = s.data

  if (s.cargando && !d) return <Page crumb="Mis solicitudes" title="Seguimiento de solicitud"><div className="card muted">Cargando…</div></Page>
  if (s.error) return <Page crumb="Mis solicitudes" title="Seguimiento de solicitud"><div className="alert alert-err">{s.error.message}</div></Page>

  const etapa = d.etapa === 'Cubierto por plan' ? ETAPAS.length : Math.max(ETAPAS.indexOf(d.etapa), 0)
  const accion = async (fn) => {
    setError('')
    try { await fn(); s.recargar() } catch (e) { setError(e.message) }
  }

  return (
    <Page crumb={`Mis solicitudes · ${codigo}`} title="Seguimiento de solicitud">
      <div className="split">
        <div className="col" style={{ gap: 16 }}>
          <div className="card">
            <div className="row between wrap">
              <div className="row">
                <div><div className="xs muted">Código</div><div className="bold mono" style={{ fontSize: 18, letterSpacing: 1 }}>{d.codigo}</div></div>
                <Badge>{d.estado}</Badge>
                {d.etapa === 'Cubierto por plan' && <Badge color="blue">Cubierto por plan</Badge>}
              </div>
              <button className="link-btn xs" onClick={s.recargar}>↻ Actualizar</button>
            </div>
            <div className="progress mt-16">
              {ETAPAS.map((e, i) => (
                <div key={e} className={`pstep ${i < etapa ? 'done' : ''} ${i === etapa && d.estado !== 'Cancelado' ? 'current' : ''}`} style={{ flex: 1 }}>
                  <div className="step-dot">{i < etapa ? '✓' : i + 1}</div>{e}
                </div>
              ))}
            </div>
          </div>

          <div className="grid g-2">
            <div className="card">
              <div className="card-title">Historial</div>
              <div className="timeline">
                {d.historial.map((h, i) => (
                  <div key={i} className="tl-item done">
                    <div className="tl-title">{h.evento}</div>
                    {h.fecha && <div className="xs muted">{fechaHora(h.fecha)}</div>}
                  </div>
                ))}
              </div>
            </div>
            <div className="card">
              <div className="card-title">Tu prestador</div>
              {d.asignacion ? (
                <>
                  <div className="row">
                    <Avatar ini={d.asignacion.prestador.split(' ').map((x) => x[0]).slice(0, 2).join('')} size="md" />
                    <div><div className="semibold">{d.asignacion.prestador}</div><div className="xs muted">{d.asignacion.especialidad} · ★ {d.asignacion.calificacion} · <Badge>{d.asignacion.estado}</Badge></div></div>
                  </div>
                  {d.asignacion.telefono && (
                    <div className="row mt-12">
                      <a className="btn btn-outline btn-sm" href={`tel:${d.asignacion.telefono}`}>📞 Llamar</a>
                      <a className="btn btn-outline btn-sm" href={`https://wa.me/1${d.asignacion.telefono}`} target="_blank" rel="noreferrer">💬 WhatsApp</a>
                    </div>
                  )}
                </>
              ) : <div className="small muted">Buscando un prestador disponible…</div>}
            </div>
          </div>
        </div>

        <div className="col" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-title">Detalle</div>
            <div className="kv">
              <div>Servicio</div><div>{d.servicios.join(', ')}</div>
              <div>Fecha</div><div>{dia(d.fecha_preferida)}{d.hora_preferida ? ` · ${hora12(d.hora_preferida)}` : ''}</div>
              <div>Modalidad</div><div>{d.modalidad}</div>
              {d.direccion_servicio && <><div>Dirección</div><div>{d.direccion_servicio}</div></>}
              <div>Total</div><div className="bold">{money(d.totales.total)}</div>
            </div>
          </div>

          {(d.puede?.confirmar || d.puede?.calificar) && (
            <div className="card" style={{ border: '1.5px dashed var(--green-600)' }}>
              <div className="card-title" style={{ marginBottom: 4 }}>{d.puede.confirmar ? 'El prestador marcó el servicio como completado' : `Califica a ${d.asignacion?.prestador || 'tu prestador'}`}</div>
              <div className="xs muted mb-8">{d.puede.confirmar ? 'Confirma que el trabajo fue realizado y califica al prestador.' : '¿Cómo fue el servicio? Tu calificación ayuda a otros clientes.'}</div>
              <div className="row" style={{ gap: 2 }} role="radiogroup" aria-label="Calificación">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} className="link-btn" aria-label={`${n} estrella${n > 1 ? 's' : ''}`} style={{ fontSize: 26, color: n <= estrellas ? '#e8a317' : '#c9d2cc' }} onClick={() => setEstrellas(n)}>★</button>
                ))}
                <span className="xs muted" style={{ marginLeft: 8 }}>{['Toca las estrellas', 'Malo', 'Regular', 'Bueno', 'Muy bueno', 'Excelente'][estrellas]}</span>
              </div>
              <textarea className="textarea mt-8" maxLength={300} placeholder="Escribe una reseña (opcional)..." style={{ minHeight: 50 }} value={comentario} onChange={(e) => setComentario(e.target.value)} />
              <button className="btn btn-primary btn-block mt-8" disabled={!estrellas}
                onClick={() => accion(() => post(`/solicitudes/${codigo}/${d.puede.confirmar ? 'confirmar' : 'calificar'}`, { calificacion: estrellas, comentario }))}>
                {d.puede.confirmar ? '✓ Confirmar finalización y calificar' : '★ Enviar calificación'}
              </button>
            </div>
          )}
          {d.asignacion?.calificacion_cliente != null && (
            <div className="card small">Calificaste este servicio con <b style={{ color: '#e8a317' }}>{'★'.repeat(d.asignacion.calificacion_cliente)}</b><span className="muted">{'★'.repeat(5 - d.asignacion.calificacion_cliente)}</span>. ¡Gracias!</div>
          )}

          {d.cobro && <ResumenCobro cobro={d.cobro} pagos={d.pagos} />}
          {d.cargos?.length > 0 && <CargosAdicionales cargos={d.cargos} puedeResponder={d.puede?.responder_cargo} codigo={codigo} onCambio={s.recargar} />}
          {d.puede?.pagar && (
            <button className="btn btn-yellow btn-block btn-lg" onClick={() => navigate(`/pagos/${codigo}`)}>
              {COBRO_LABEL[d.cobro.siguiente]} {money(d.cobro.monto_siguiente)}
            </button>
          )}
          {error && <div className="alert alert-err">{error}</div>}

          {d.puede?.cancelar && (
            <>
              <button className="btn btn-danger btn-block" onClick={() => setCancelar(true)}>Cancelar solicitud</button>
              <div className="xs muted center" style={{ marginTop: -8 }}>Solo disponible en estado Pendiente o hasta 12 h antes de la cita.</div>
            </>
          )}
        </div>
      </div>

      {cancelar && (
        <Modal titulo="Cancelar solicitud" onClose={() => setCancelar(false)}>
          <Field label="Motivo (opcional)"><input className="input" value={motivo} onChange={(e) => setMotivo(e.target.value)} /></Field>
          <div className="row end mt-16">
            <button className="btn btn-ghost" onClick={() => setCancelar(false)}>Volver <span className="kbd">Esc</span></button>
            <button className="btn btn-danger" onClick={() => { setCancelar(false); accion(() => post(`/solicitudes/${codigo}/cancelar`, { motivo })) }}>Cancelar solicitud</button>
          </div>
        </Modal>
      )}
    </Page>
  )
}

// SOL-P03 · Mis solicitudes y centro de notificaciones (Figura 40)
const ESTADOS = ['Pendiente', 'En proceso', 'Completado', 'Cancelado']

export function MisSolicitudes() {
  const navigate = useNavigate()
  const [filtro, setFiltro] = useState('Todas')
  const sol = useApi('/solicitudes/mias')
  const notifs = useApi('/notificaciones')
  const todas = sol.data || []
  const cuenta = (e) => todas.filter((s) => s.estado === e).length
  const lista = todas.filter((s) => filtro === 'Todas' || s.estado === filtro)
  const cancelar = async (codigo) => {
    if (!window.confirm(`¿Cancelar la solicitud ${codigo}?`)) return
    try { await post(`/solicitudes/${codigo}/cancelar`, {}); sol.recargar() } catch (e) { window.alert(e.message) }
  }
  const leerTodas = async () => { await post('/notificaciones/leer-todas'); notifs.recargar() }

  return (
    <Page crumb="Inicio · Mis solicitudes" title="Mis solicitudes">
      <div className="split">
        <div className="card">
          <div className="row between wrap mb-12">
            <Chips valor={filtro} onChange={setFiltro} opciones={[
              { value: 'Todas', label: `Todas (${todas.length})` },
              ...ESTADOS.map((e) => ({ value: e, label: `${e} (${cuenta(e)})` })),
            ]} />
            <button className="btn btn-primary btn-sm" onClick={() => navigate('/solicitudes/nueva')}>＋ Nueva solicitud</button>
          </div>
          {sol.error && <div className="alert alert-err">{sol.error.message}</div>}
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Código</th><th>Servicio</th><th>Prestador</th><th>Fecha</th><th className="num">Total</th><th>Estado</th><th>Pago</th><th>Acciones</th></tr></thead>
              <tbody>
                {lista.map((s) => (
                  <tr key={s.codigo}>
                    <td className="bold mono">{s.codigo}</td>
                    <td>{s.servicio}</td>
                    <td>{s.prestador || '—'}</td>
                    <td>{dia(s.fecha)}</td>
                    <td className="num">RD$ {num(s.total)}</td>
                    <td><Badge>{s.estado}</Badge></td>
                    <td>{s.pago ? <Badge>{s.pago}</Badge> : <span className="muted">—</span>}</td>
                    <td>
                      <div className="col" style={{ gap: 4, alignItems: 'flex-start' }}>
                        <button className="btn btn-outline btn-sm" onClick={() => navigate(`/seguimiento/${s.codigo}`)}>Ver</button>
                        {s.estado === 'Pendiente' && <button className="btn btn-danger btn-sm" onClick={() => cancelar(s.codigo)}>Cancelar</button>}
                        {s.por_pagar && <button className="btn btn-yellow btn-sm" onClick={() => navigate(`/pagos/${s.codigo}`)}>{{ Total: 'Pagar', Cargo: 'Pagar cargo adicional' }[s.por_pagar.tipo] || `Pagar ${s.por_pagar.tipo.toLowerCase()}`} {money(s.por_pagar.monto)}</button>}
                        {s.calificar && <button className="btn btn-yellow btn-sm" onClick={() => navigate(`/seguimiento/${s.codigo}`)}>★ Calificar</button>}
                        {s.facturas.map((f) => <button key={f.numero} className="btn btn-primary btn-sm" onClick={() => navigate(`/facturas/${f.numero}`)}>📄 {{ Total: 'Factura', Anticipo: 'Factura', Cargo: 'Nota de débito' }[f.tipo] || f.tipo}</button>)}
                      </div>
                    </td>
                  </tr>
                ))}
                {!lista.length && <tr><td colSpan={8} className="center muted">{sol.cargando ? 'Cargando…' : 'No tienes solicitudes en este estado.'}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card flush">
          <div className="row between" style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
            <span className="bold">Notificaciones</span>
            <button className="link-btn small" onClick={leerTodas}>Marcar todo como leído</button>
          </div>
          {(notifs.data?.items || []).slice(0, 8).map((n) => (
            <div key={n.id_notificacion} className={`notif ${n.leida ? '' : 'unread'}`}>
              <span>{{ Solicitud: '🛠️', Pago: '💳', Factura: '📄' }[n.tipo] || '🔔'}</span>
              <div className="grow"><div className="semibold">{n.titulo}</div><div className="xs muted">{hace(n.fecha_creacion)}</div></div>
              {!n.leida && <span className="notif-dot" />}
            </div>
          ))}
          {!notifs.data?.items?.length && <div className="small muted center" style={{ padding: 16 }}>Sin notificaciones.</div>}
        </div>
      </div>
    </Page>
  )
}

const AGENDA = [
  { hora: '10:00 a. m.', servicio: 'Reparación eléctrica', codigo: 'SOL-2K7Q9X', cliente: 'María Rodríguez · Piantini', estado: 'En proceso' },
  { hora: '1:30 p. m.', servicio: 'Diagnóstico eléctrico', codigo: 'SOL-4FD7NN', cliente: 'Textiles Caribe SRL · Naco', estado: 'Aceptada' },
  { hora: '4:00 p. m.', servicio: 'Cambio de breakers', codigo: 'SOL-8BQ3L5', cliente: 'Rosa Martínez · Gazcue', estado: 'Aceptada' },
]

function Disponibilidad({ valor, onChange }) {
  return (
    <div className="row wrap">
      <b className="small">Mi disponibilidad:</b>
      {['Disponible', 'Ocupado', 'No disponible'].map((d) => (
        <button key={d} className={`chip ${valor === d ? 'active' : ''}`} onClick={() => onChange(d)}>{valor === d ? '● ' : ''}{d}</button>
      ))}
    </div>
  )
}

// SOL-P04 / PAG-P05 · Panel del prestador (Figura 41)
export function PanelPrestador() {
  const panel = useApi('/prestador/panel')
  const [efectivo, setEfectivo] = useState(null)
  const [completar, setCompletar] = useState(null)
  const [error, setError] = useState('')
  const d = panel.data

  const accion = async (fn) => {
    setError('')
    try { await fn(); panel.recargar() } catch (e) { setError(e.message) }
  }
  const nueva = d?.nuevas?.[0]

  return (
    <Page crumb="Prestador · Panel" title="Mi panel de trabajo">
      {panel.error && <div className="alert alert-err mb-16">{panel.error.message}</div>}
      {error && <div className="alert alert-err mb-16">{error}</div>}
      <div className="row between mb-16">
        <Disponibilidad valor={d?.disponibilidad} onChange={(v) => accion(() => patch('/prestador/disponibilidad', { estado: v }))} />
        <button className="link-btn small" onClick={panel.recargar}>↻ Actualizar</button>
      </div>
      <div className="grid g-4 mb-16">
        <Kpi label="Servicios hoy" value={d?.kpis.hoy ?? '—'} foot={`${d?.agenda.filter((a) => a.estado === 'En proceso').length ?? 0} en proceso`} />
        <Kpi label="Por aceptar" value={d?.kpis.por_aceptar ?? '—'} foot={nueva ? `vence en ${restante(nueva.vence)}` : '—'} color="var(--orange)" />
        <Kpi label="Completados (mes)" value={d?.kpis.completados_mes ?? '—'} />
        <Kpi label="Calificación" value={d ? `★ ${d.kpis.calificacion}` : '—'} foot={d ? `${d.kpis.resenas} reseñas` : ''} />
      </div>

      <div className="grid g-2">
        <div className="card" style={nueva ? { border: '2px solid #f0b54a' } : undefined}>
          <div className="row between mb-12">
            <div className="card-title" style={{ margin: 0 }}>Nueva asignación {d?.nuevas.length > 1 && <span className="muted small">(1 de {d.nuevas.length})</span>}</div>
            {nueva && <Badge color="yellow">⏱ Responder en {restante(nueva.vence)}</Badge>}
          </div>
          {nueva ? (
            <>
              <div className="kv">
                <div>Código</div><div><b>{nueva.codigo}</b> · Asignación {nueva.tipo.toLowerCase()}</div>
                <div>Servicio</div><div>{nueva.servicio}</div>
                <div>Cliente</div><div>{nueva.cliente}</div>
                <div>Dirección</div><div>{nueva.direccion || 'Remoto / virtual'}</div>
                <div>Fecha</div><div>{diaDeFecha(nueva.fecha)} {dia(nueva.fecha)}{nueva.hora ? ` · ${hora12(nueva.hora)}` : ''}</div>
                <div>Descripción</div><div>{nueva.descripcion || '—'}</div>
                <div>Monto estimado</div><div><b>{money(nueva.total)}</b> (incl. ITBIS)</div>
              </div>
              <div className="grid g-2 mt-16" style={{ gap: 10 }}>
                <button className="btn btn-primary" onClick={() => accion(() => post(`/prestador/asignaciones/${nueva.id_asignacion}/aceptar`))}>✓ Aceptar solicitud</button>
                <button className="btn btn-danger" onClick={() => window.confirm('¿Rechazar esta asignación?') && accion(() => post(`/prestador/asignaciones/${nueva.id_asignacion}/rechazar`))}>✕ Rechazar</button>
              </div>
              <div className="xs muted mt-8">Si rechazas o no respondes, el sistema la reasigna automáticamente.</div>
            </>
          ) : <div className="small muted">{panel.cargando ? 'Cargando…' : 'No tienes asignaciones nuevas.'}</div>}
        </div>

        <div className="card">
          <div className="card-title">📅 Agenda de hoy · {diaSemana(new Date())} {dia(isoDia())}</div>
          {(d?.agenda || []).map((a) => (
            <div key={a.codigo} style={{ padding: '9px 0', borderBottom: '1px solid #edf1ee' }}>
              <div className="row">
                <b className="small" style={{ width: 80 }}>{a.hora ? hora12(a.hora) : '—'}</b>
                <div className="grow"><div className="semibold small">{a.servicio} <span className="xs muted">{a.codigo}</span></div><div className="xs muted">{a.cliente} · {a.direccion || 'Remoto'}</div></div>
                <Badge>{a.estado_asignacion === 'Completada' ? (a.estado === 'Completado' ? 'Completado' : 'Esperando confirmación') : a.estado}</Badge>
              </div>
              <div className="row wrap mt-8" style={{ paddingLeft: 90 }}>
                {a.estado_asignacion === 'Aceptada' && (
                  <button className="btn btn-primary btn-sm" disabled={!a.anticipo_listo} title={a.anticipo_listo ? '' : 'Falta el anticipo del 50 %'} onClick={() => setCompletar(a)}>✓ Marcar completado</button>
                )}
                {a.cobro_efectivo && <button className="btn btn-outline btn-sm" onClick={() => setEfectivo(a)}>💵 Cobrar {a.cobro_efectivo.tipo === 'Total' ? 'total' : a.cobro_efectivo.tipo.toLowerCase()} en efectivo</button>}
                {a.estado_asignacion === 'Aceptada' && !a.anticipo_listo && <span className="xs yellow-t">Esperando anticipo del 50 %</span>}
                {a.pago && <span className="xs muted">Pago: <Badge>{a.pago}</Badge></span>}
              </div>
            </div>
          ))}
          {!d?.agenda?.length && <div className="small muted">No tienes servicios aceptados para hoy.</div>}
          <div className="xs muted mt-8">Las asignaciones de otros días están en <b>Asignaciones</b>.</div>
        </div>
      </div>
      {completar && <CompletarServicio asignacion={completar} onClose={() => setCompletar(null)} onListo={() => { setCompletar(null); panel.recargar() }} />}
      {efectivo && <ReportarEfectivo codigo={efectivo.codigo} tipo={efectivo.cobro_efectivo.tipo} total={efectivo.cobro_efectivo.monto} onClose={() => setEfectivo(null)} onListo={() => { setEfectivo(null); panel.recargar() }} />}
    </Page>
  )
}

/** Marcar completado, con materiales adicionales opcionales (16.5.3 C.4). */
function CompletarServicio({ asignacion, onClose, onListo }) {
  const [materiales, setMateriales] = useState([])
  const [error, setError] = useState('')
  const set = (i, k, v) => setMateriales(materiales.map((m, j) => (j === i ? { ...m, [k]: v } : m)))
  const enviar = async () => {
    setError('')
    try {
      await post(`/prestador/asignaciones/${asignacion.id_asignacion}/completar`, { materiales: materiales.map((m) => ({ ...m, precio: Number(m.precio), cantidad: Number(m.cantidad) })) })
      onListo()
    } catch (e) { setError(e.message) }
  }
  return (
    <Modal titulo={`✓ Marcar completado · ${asignacion.codigo}`} onClose={onClose}>
      <div className="small muted mb-12">Si usaste materiales adicionales, agrégalos: se suman a la factura con ITBIS.</div>
      {materiales.map((m, i) => (
        <div key={i} className="row mb-8">
          <input className="input grow" placeholder="Material (ej. breaker 20 A)" value={m.descripcion} onChange={(e) => set(i, 'descripcion', e.target.value)} />
          <input className="input" style={{ width: 70 }} inputMode="numeric" placeholder="Cant." value={m.cantidad} onChange={(e) => set(i, 'cantidad', entero(e.target.value, 2))} />
          <input className="input" style={{ width: 110 }} inputMode="decimal" placeholder="Precio RD$" value={m.precio} onChange={(e) => set(i, 'precio', decimal(e.target.value))} />
          <button className="btn btn-danger btn-sm" onClick={() => setMateriales(materiales.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button className="link-btn small" onClick={() => setMateriales([...materiales, { descripcion: '', cantidad: 1, precio: '' }])}>＋ Agregar material</button>
      {error && <div className="alert alert-err mt-12">{error}</div>}
      <div className="row end mt-16">
        <button className="btn btn-ghost" onClick={onClose}>Cancelar <span className="kbd">Esc</span></button>
        <button className="btn btn-primary" onClick={enviar}>Marcar completado</button>
      </div>
    </Modal>
  )
}

export function Asignaciones() {
  const [f, setF] = useState('Todas')
  const lista = useApi(f === 'Todas' ? '/prestador/asignaciones' : `/prestador/asignaciones?estado=${encodeURIComponent(f)}`)
  const [completar, setCompletar] = useState(null)
  const [efectivo, setEfectivo] = useState(null)
  const [cargo, setCargo] = useState(null)
  const [error, setError] = useState('')
  const accion = async (fn) => {
    setError('')
    try { await fn(); lista.recargar() } catch (e) { setError(e.message) }
  }
  // Estado visible: la asignación Completada sigue "En proceso" hasta que el cliente confirma
  const estadoVisible = (r) =>
    r.estado_asignacion === 'Completada' && r.estado === 'En proceso' ? 'Esperando confirmación del cliente' : r.estado_asignacion

  return (
    <Page crumb="Prestador · Asignaciones" title="Mis asignaciones">
      <div className="card">
        <div className="row between wrap mb-12">
          <Chips valor={f} onChange={setF} opciones={['Todas', 'Asignada', 'Aceptada', 'Completada', 'Rechazada']} />
          <button className="link-btn small" onClick={lista.recargar}>↻ Actualizar</button>
        </div>
        {lista.error && <div className="alert alert-err">{lista.error.message}</div>}
        {error && <div className="alert alert-err mb-12">{error}</div>}
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Código</th><th>Servicio</th><th>Cliente</th><th>Dirección</th><th>Fecha</th><th className="num">Monto</th><th>Estado</th><th>Acciones</th></tr></thead>
            <tbody>
              {(lista.data || []).map((r) => (
                <tr key={r.id_asignacion}>
                  <td className="bold">{r.codigo}<div className="xs muted">{r.tipo_asignacion}</div></td><td>{r.servicio}</td><td>{r.cliente}</td><td>{r.direccion_servicio || 'Remoto'}</td>
                  <td>{dia(r.fecha_preferida)}{r.hora_preferida ? ` · ${hora12(r.hora_preferida)}` : ''}</td>
                  <td className="num">RD$ {num(r.total)}</td>
                  <td><Badge color={estadoVisible(r).startsWith('Esperando') ? 'blue' : undefined}>{estadoVisible(r)}</Badge>{r.pago && <div className="xs muted mt-8">Pago: {r.pago}</div>}</td>
                  <td>
                    <div className="col" style={{ gap: 4, alignItems: 'flex-start' }}>
                      {r.estado_asignacion === 'Asignada' && r.estado === 'Pendiente' && (
                        <>
                          <button className="btn btn-primary btn-sm" onClick={() => accion(() => post(`/prestador/asignaciones/${r.id_asignacion}/aceptar`))}>✓ Aceptar</button>
                          <button className="btn btn-danger btn-sm" onClick={() => window.confirm('¿Rechazar esta asignación?') && accion(() => post(`/prestador/asignaciones/${r.id_asignacion}/rechazar`))}>✕ Rechazar</button>
                        </>
                      )}
                      {r.estado_asignacion === 'Aceptada' && r.estado === 'En proceso' && (
                        <button className="btn btn-primary btn-sm" disabled={!r.anticipo_listo} title={r.anticipo_listo ? '' : 'Falta el anticipo del 50 %'} onClick={() => setCompletar(r)}>✓ Marcar completado</button>
                      )}
                      {r.estado_asignacion === 'Aceptada' && r.estado === 'En proceso' && !r.anticipo_listo && <span className="xs yellow-t">Esperando anticipo del 50 %</span>}
                      {r.cobro_efectivo && (
                        <button className="btn btn-outline btn-sm" onClick={() => setEfectivo(r)}>💵 Cobrar {{ Total: 'total', Cargo: 'cargo adicional' }[r.cobro_efectivo.tipo] || r.cobro_efectivo.tipo.toLowerCase()} en efectivo</button>
                      )}
                      {r.puede_cargo && <button className="btn btn-outline btn-sm" onClick={() => setCargo(r)}>＋ Cargo adicional</button>}
                      {r.cargos?.map((c) => (
                        <div key={c.id_cargo} className="xs">
                          Cargo: {c.descripcion} · {money(c.total)} <Badge color={c.estado === 'Pagado' ? 'green' : undefined}>{c.estado}</Badge>
                          {c.estado === 'Pendiente' && <button className="link-btn xs" onClick={() => window.confirm('¿Retirar este cargo?') && accion(() => post(`/prestador/cargos/${c.id_cargo}/anular`))}> Retirar</button>}
                        </div>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
              {!lista.data?.length && <tr><td colSpan={8} className="center muted">{lista.cargando ? 'Cargando…' : 'No hay asignaciones.'}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {completar && <CompletarServicio asignacion={completar} onClose={() => setCompletar(null)} onListo={() => { setCompletar(null); lista.recargar() }} />}
      {efectivo && <ReportarEfectivo codigo={efectivo.codigo} tipo={efectivo.cobro_efectivo.tipo} total={efectivo.cobro_efectivo.monto} onClose={() => setEfectivo(null)} onListo={() => { setEfectivo(null); lista.recargar() }} />}
      {cargo && <SolicitarCargo asignacion={cargo} onClose={() => setCargo(null)} onListo={() => { setCargo(null); lista.recargar() }} />}
    </Page>
  )
}

export function Agenda() {
  const dias = ['Lun 05', 'Mar 06', 'Mié 07', 'Jue 08', 'Vie 09', 'Sáb 10']
  const citas = { 'Mar 06': AGENDA, 'Jue 08': [{ hora: '2:00 p. m.', servicio: 'Instalación de lámparas', codigo: 'SOL-9PL2AA', cliente: 'Juan Pérez · Naco', estado: 'Asignada' }] }
  return (
    <Page crumb="Prestador · Agenda" title="Agenda semanal">
      <div className="grid g-3">
        {dias.map((d) => (
          <div key={d} className="card">
            <div className="card-title">{d} oct.</div>
            {(citas[d] || []).map((c) => (
              <div key={c.codigo} className="mb-8" style={{ borderLeft: '3px solid var(--green-700)', paddingLeft: 8 }}>
                <div className="small"><b>{c.hora}</b> · {c.servicio}</div>
                <div className="xs muted">{c.cliente}</div>
                <Badge>{c.estado}</Badge>
              </div>
            ))}
            {!citas[d] && <div className="small muted">Sin citas · Disponible 8:00 a. m. – 6:00 p. m.</div>}
          </div>
        ))}
      </div>
    </Page>
  )
}

export function Calificaciones() {
  return (
    <Page crumb="Prestador · Calificaciones" title="Mis calificaciones">
      <div className="split">
        <div className="card">
          <div className="card-title">Reseñas de clientes</div>
          {[...resenas, { autor: 'María R.', estrellas: 5, cuando: 'hace 1 mes', texto: 'Muy profesional y limpio en su trabajo.' }].map((r) => (
            <div key={r.autor} style={{ padding: '10px 0', borderBottom: '1px solid #edf1ee' }}>
              <div className="small"><b>{r.autor}</b> <Stars n={r.estrellas} /> <span className="xs muted">· {r.cuando}</span></div>
              <div className="small">{r.texto}</div>
            </div>
          ))}
        </div>
        <div className="card center">
          <div className="kpi-value" style={{ fontSize: 40 }}>4.8</div>
          <Stars n={4.8} size={20} />
          <div className="small muted">126 reseñas</div>
          <div className="col mt-16" style={{ gap: 6, textAlign: 'left' }}>
            {[[5, 92], [4, 26], [3, 6], [2, 1], [1, 1]].map(([s, n]) => (
              <div key={s} className="row small"><span style={{ width: 24 }}>{s}★</span><div className="bar grow"><span style={{ width: `${(n / 126) * 100}%` }} /></div><span style={{ width: 24 }} className="right">{n}</span></div>
            ))}
          </div>
        </div>
      </div>
    </Page>
  )
}

export function PerfilPrestadorPropio() {
  const [disp, setDisp] = useState('Disponible')
  return (
    <Page crumb="Prestador · Mi perfil" title="Mi perfil y disponibilidad">
      <div className="card mb-16"><Disponibilidad valor={disp} onChange={setDisp} /><div className="xs muted mt-8">Tu estado afecta la asignación automática de solicitudes.</div></div>
      <div className="card">
        <div className="form-grid">
          <Field label="Especialidad"><input className="input" defaultValue="Electricista residencial y comercial" onInput={soloTextoSinNumeros} /></Field>
          <Field label="Tarifa por hora (RD$)"><input className="input" inputMode="decimal" defaultValue="900.00" onInput={soloDecimal} /></Field>
          <Field label="Zona de cobertura"><input className="input" defaultValue="Los Jardines Metropolitanos, Cerros de Gurabo, Villa Olga, La Trinitaria" onInput={soloTextoSinNumeros} /></Field>
          <Field label="Horario de trabajo"><input className="input" defaultValue="Lunes a sábado · 8:00 a. m. – 6:00 p. m." /></Field>
          <Field label="Presentación" className="full"><textarea className="textarea" defaultValue="Instalaciones y reparaciones eléctricas, cambio de breakers, cableado, lámparas, tomas 110/220 V y diagnóstico de cortocircuitos. Trabajo con garantía de 30 días." /></Field>
        </div>
        <div className="row end mt-16"><button className="btn btn-primary">Guardar cambios</button></div>
      </div>
    </Page>
  )
}

// Solicitudes (vista del administrador)
export function SolicitudesAdmin() {
  const [f, setF] = useState('Todas')
  const lista = solicitudesAdmin.filter((s) => f === 'Todas' || s.estado === f)
  return (
    <Page crumb="Administración · Solicitudes" title="Solicitudes">
      <div className="card">
        <div className="mb-12"><Chips valor={f} onChange={setF} opciones={['Todas', 'Pendiente', 'En proceso', 'Completado', 'Cancelado']} /></div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Código</th><th>Cliente</th><th>Servicio</th><th>Prestador</th><th>Fecha</th><th className="num">Total</th><th>Estado</th><th>Acciones</th></tr></thead>
            <tbody>
              {lista.map((s) => (
                <tr key={s.codigo}>
                  <td className="bold mono">{s.codigo}</td><td>{s.cliente}</td><td>{s.servicio}</td>
                  <td>{s.prestador === '—' && s.estado === 'Pendiente' ? <Badge color="orange">Sin prestador</Badge> : s.prestador}</td>
                  <td>{s.fecha}</td><td className="num">RD$ {num(s.total)}</td><td><Badge>{s.estado}</Badge></td>
                  <td className="nowrap">
                    {s.prestador === '—' && s.estado === 'Pendiente' && <button className="btn btn-primary btn-sm">Asignar</button>}{' '}
                    {['Pendiente', 'En proceso'].includes(s.estado) && <button className="btn btn-danger btn-sm">Cancelar</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Page>
  )
}

const COBRO_LABEL = { Anticipo: 'Pagar anticipo (50 %)', Saldo: 'Pagar saldo (50 %)', Total: 'Ir a pagar', Cargo: 'Pagar cargo adicional' }

/**
 * Cargos adicionales que solicitó el prestador después del servicio. El cliente los acepta o rechaza;
 * el cargo aceptado se paga como cualquier cobro y se factura con una nota de débito (e33).
 */
function CargosAdicionales({ cargos, puedeResponder, codigo, onCambio }) {
  const navigate = useNavigate()
  const [rechazar, setRechazar] = useState(null)
  const [motivo, setMotivo] = useState('')
  const [ocupado, setOcupado] = useState(null)
  const [error, setError] = useState('')
  const responder = async (c, decision, motivoRechazo) => {
    setError('')
    setOcupado(c.id_cargo)
    try {
      await post(`/solicitudes/${codigo}/cargos/${c.id_cargo}/responder`, { decision, motivo: motivoRechazo })
      onCambio()
    } catch (e) {
      setError(e.message)
    } finally {
      setOcupado(null)
    }
  }
  return (
    <div className="card small">
      <div className="card-title" style={{ marginBottom: 4 }}>Cargos adicionales</div>
      <div className="xs muted mb-8">Trabajo o material extra que el prestador te solicita después del servicio. Solo se cobra si lo aceptas.</div>
      {cargos.map((c) => (
        <div key={c.id_cargo} style={{ padding: '8px 0', borderBottom: '1px solid #edf1ee' }}>
          <div className="row between"><span className="semibold">{c.descripcion}</span><Badge color={c.estado === 'Pagado' ? 'green' : undefined}>{c.estado}</Badge></div>
          <div className="row between xs muted">
            <span>{c.cantidad} × {money(c.precio_unitario)}{c.aplica_itbis ? ' + ITBIS' : ''}</span><span className="bold">{money(c.total)}</span>
          </div>
          {c.motivo && <div className="xs mt-8">«{c.motivo}»</div>}
          {c.motivo_rechazo && <div className="xs muted mt-8">Rechazado: {c.motivo_rechazo}</div>}
          {c.estado === 'Pendiente' && puedeResponder && (
            <div className="row mt-8" style={{ gap: 6 }}>
              <button className="btn btn-primary btn-sm" disabled={ocupado === c.id_cargo} onClick={() => responder(c, 'Aceptar')}>✓ Aceptar cargo</button>
              <button className="btn btn-danger btn-sm" disabled={ocupado === c.id_cargo} onClick={() => { setRechazar(c); setMotivo('') }}>✕ Rechazar</button>
            </div>
          )}
          {c.pago?.numero_factura && (
            <div className="row mt-8"><button className="btn btn-primary btn-sm" onClick={() => navigate(`/facturas/${c.pago.numero_factura}`)}>📄 Nota de débito</button></div>
          )}
          {c.estado === 'Aceptado' && c.pago && <div className="xs muted mt-8">Pago {c.pago.estado.toLowerCase()}</div>}
        </div>
      ))}
      {error && <div className="alert alert-err mt-8">{error}</div>}
      {rechazar && (
        <Modal titulo="Rechazar cargo adicional" onClose={() => setRechazar(null)}>
          <div className="small mb-12">{rechazar.descripcion} · {money(rechazar.total)}</div>
          <Field label="Motivo (opcional)" hint="Se le envía al prestador"><input className="input" maxLength={200} value={motivo} onChange={(e) => setMotivo(e.target.value)} /></Field>
          <div className="row end mt-16">
            <button className="btn btn-ghost" onClick={() => setRechazar(null)}>Volver <span className="kbd">Esc</span></button>
            <button className="btn btn-danger" onClick={() => { const c = rechazar; setRechazar(null); responder(c, 'Rechazar', motivo) }}>Rechazar cargo</button>
          </div>
        </Modal>
      )}
    </div>
  )
}

/** El prestador solicita un cargo adicional (trabajo o material extra) al cliente. */
function SolicitarCargo({ asignacion, onClose, onListo }) {
  const [c, setC] = useState({ descripcion: '', motivo: '', cantidad: 1, precio: '', aplica_itbis: true })
  const [error, setError] = useState(null)
  const [enviando, setEnviando] = useState(false)
  const precio = Number(String(c.precio).replace(/,/g, '')) || 0
  const subtotal = precio * (Number(c.cantidad) || 0)
  const total = subtotal * (c.aplica_itbis ? 1.18 : 1)
  const enviar = async () => {
    setError(null)
    setEnviando(true)
    try {
      await post(`/prestador/asignaciones/${asignacion.id_asignacion}/cargos`, { ...c, cantidad: Number(c.cantidad), precio })
      onListo()
    } catch (e) {
      setError(e)
    } finally {
      setEnviando(false)
    }
  }
  return (
    <Modal titulo={`Cargo adicional · ${asignacion.codigo}`} onClose={onClose}>
      <div className="alert alert-info small mb-12">
        El cliente debe aceptarlo desde el seguimiento de su solicitud. Al pagarlo, el sistema emite una <b>nota de débito electrónica</b> ligada a la factura del servicio.
      </div>
      <div className="form-grid">
        <Field label="Descripción" req className="full" error={error?.detalles?.descripcion}>
          <input className="input" maxLength={120} placeholder="Ej.: Reemplazo de breaker 20 A" value={c.descripcion} onChange={(e) => setC({ ...c, descripcion: e.target.value })} />
        </Field>
        <Field label="¿Por qué se cobra?" req className="full" error={error?.detalles?.motivo}>
          <textarea className="textarea" maxLength={300} style={{ minHeight: 60 }} value={c.motivo} onChange={(e) => setC({ ...c, motivo: e.target.value })} />
        </Field>
        <Field label="Cantidad" error={error?.detalles?.cantidad}><input className="input" inputMode="numeric" value={c.cantidad} onChange={(e) => setC({ ...c, cantidad: entero(e.target.value, 2) })} /></Field>
        <Field label="Precio unitario (RD$)" req error={error?.detalles?.precio}><input className="input" inputMode="decimal" value={c.precio} onChange={(e) => setC({ ...c, precio: decimal(e.target.value) })} /></Field>
        <label className="row small full" style={{ gap: 6 }}><input type="checkbox" checked={c.aplica_itbis} onChange={(e) => setC({ ...c, aplica_itbis: e.target.checked })} /> Aplica ITBIS (18 %)</label>
      </div>
      <div className="row between mt-12 small"><span>Total para el cliente</span><b>{money(total)}</b></div>
      {error && !error.detalles && <div className="alert alert-err mt-12">{error.message}</div>}
      <div className="row end mt-16">
        <button className="btn btn-ghost" onClick={onClose}>Cancelar <span className="kbd">Esc</span></button>
        <button className="btn btn-primary" disabled={enviando || !c.descripcion.trim() || !c.motivo.trim() || !(precio > 0)} onClick={enviar}>{enviando ? 'Enviando…' : 'Enviar al cliente'}</button>
      </div>
    </Modal>
  )
}

/** Anticipo y saldo de la solicitud con su estado y sus facturas. */
function ResumenCobro({ cobro, pagos }) {
  const navigate = useNavigate()
  const fila = (titulo, tipo, monto, info) => {
    const p = pagos.find((x) => x.tipo_pago === tipo)
    return (
      <div style={{ padding: '8px 0', borderBottom: '1px solid #edf1ee' }}>
        <div className="row between"><span className="semibold">{titulo}</span>{p ? <Badge>{p.estado}</Badge> : <Badge color="gray">Pendiente</Badge>}</div>
        <div className="row between xs muted"><span>{info}</span><span>{monto !== null ? money(monto) : ''}</span></div>
        {p && (
          <div className="row mt-8" style={{ gap: 6 }}>
            {p.estado === 'Confirmado' && <button className="btn btn-outline btn-sm" onClick={() => navigate(`/pagos/recibo/${p.id_pago}`)}>Recibo</button>}
            {p.numero_factura && (
              <button className="btn btn-primary btn-sm" onClick={() => navigate(`/facturas/${p.numero_factura}`)}>
                📄 {tipo === 'Saldo' && pagos.some((x) => x.tipo_pago === 'Anticipo' && x.numero_factura === p.numero_factura) ? 'Abonado a la factura' : 'Factura'} {p.ncf || ''}
              </button>
            )}
          </div>
        )}
      </div>
    )
  }
  if (cobro.total_servicio === 0) return <div className="alert alert-info">Este servicio está cubierto por tu plan; no requiere pago.</div>
  return (
    <div className="card small">
      <div className="card-title" style={{ marginBottom: 4 }}>Pagos del servicio</div>
      <div className="xs muted mb-8">Total del servicio: <b>{money(cobro.total_servicio)}</b> · 50 % al aceptar, 50 % al finalizar, en una sola factura</div>
      {cobro.total
        ? fila('Pago único', 'Total', cobro.total.monto, 'Pago completo')
        : <>
            {fila('Anticipo 50 %', 'Anticipo', cobro.anticipo?.monto ?? (cobro.siguiente === 'Anticipo' ? cobro.monto_siguiente : null), 'Al aceptar el prestador')}
            {fila('Saldo 50 %', 'Saldo', cobro.saldo?.monto ?? (cobro.siguiente === 'Saldo' ? cobro.monto_siguiente : null), 'Al finalizar (incluye materiales)')}
          </>}
      {cobro.motivo && !cobro.siguiente && <div className="xs muted mt-8">{cobro.motivo}</div>}
    </div>
  )
}
