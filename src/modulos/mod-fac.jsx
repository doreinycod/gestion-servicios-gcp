// MOD-FAC · Facturación (NCF / e-CF)
// FAC-P01 / FAC-P02 Representación impresa y Mis facturas · FAC-P03 Control de e-CF y secuencias
// FAC-P04 Notas de crédito (e34) y débito (e33)
import { useNavigate, useParams } from 'react-router-dom'
import { Page } from '../components/Layout'
import { Badge, QrFake, QrDgii, Chips, Field, Modal } from '../components/ui'
import { num, num0, dia, fecha, fechaHora, formatoCedula, money, isoDia } from '../lib/format'
import { useState } from 'react'

import { api, leerSesion, post } from '../lib/api'
import { useApi } from '../lib/useApi'
import { useSession } from '../components/session'
import { rncCedula, decimal, entero } from '../lib/filtros'

const TIPO_ECF = { e31: 'Crédito Fiscal', e32: 'Consumo', e33: 'Nota de Débito', e34: 'Nota de Crédito' }
const COLOR_DOC = { Factura: 'gray', 'Nota de crédito': 'blue', 'Nota de débito': 'orange' }

/** Tipo de documento con el comprobante que modifica (notas y sustituciones). */
function Documento({ f }) {
  return (
    <>
      <Badge color={COLOR_DOC[f.tipo_documento]}>{f.tipo_documento}{f.tipo_ecf ? ` · ${f.tipo_ecf}` : ''}</Badge>
      {f.origen_ncf && <div className="xs muted">{f.tipo_documento === 'Factura' ? 'Sustituye' : 'Modifica'} {f.origen_ncf}</div>}
    </>
  )
}

const MOTIVOS_NC = ['Cobro de más', 'Servicio no realizado', 'Servicio incompleto o deficiente', 'Error en la factura', 'Otro']

/** FAC-P04 · El cliente pide una nota de crédito; administración la aprueba o la rechaza. */
function SolicitarNotaCredito({ factura, onClose, onListo }) {
  const esDebito = factura.tipo_documento === 'Nota de débito'
  const [d, setD] = useState({ motivo: '', detalle: '', tipo: 'Total', monto: '' })
  const [error, setError] = useState(null)
  const [enviando, setEnviando] = useState(false)
  const [listo, setListo] = useState(false)
  const monto = Number(String(d.monto).replace(/,/g, '')) || 0
  const enviar = async () => {
    setError(null)
    setEnviando(true)
    try {
      await post(`/facturas/${factura.numero_factura}/solicitar-nota-credito`, { ...d, tipo: esDebito ? 'Total' : d.tipo, monto })
      setListo(true)
      onListo()
    } catch (e) {
      setError(e)
    } finally {
      setEnviando(false)
    }
  }
  return (
    <Modal titulo="Solicitar nota de crédito" onClose={onClose}>
      {listo ? (
        <>
          <div className="alert alert-ok mb-12">Recibimos tu solicitud. Administración la revisará y te avisará por la app y por correo.</div>
          <div className="row end"><button className="btn btn-primary" onClick={onClose}>Cerrar</button></div>
        </>
      ) : (
        <>
          <div className="small mb-12">{factura.tipo_documento} <b>{factura.numero_factura}</b> · e-NCF <span className="mono">{factura.ncf}</span> · disponible para acreditar <b>{money(factura.disponible_credito)}</b></div>
          <Field label="Motivo" req error={error?.detalles?.motivo}>
            <select className="select" value={d.motivo} onChange={(e) => setD({ ...d, motivo: e.target.value })}>
              <option value="">Seleccione…</option>
              {MOTIVOS_NC.map((m) => <option key={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="¿Qué ocurrió?" req error={error?.detalles?.detalle} hint="Mínimo 10 caracteres">
            <textarea className="textarea" maxLength={500} style={{ minHeight: 70 }} value={d.detalle} onChange={(e) => setD({ ...d, detalle: e.target.value })} />
          </Field>
          {!esDebito && (
            <>
              <Chips valor={d.tipo} onChange={(tipo) => setD({ ...d, tipo })} opciones={[
                { value: 'Total', label: `Total (${money(factura.disponible_credito)})` }, { value: 'Parcial', label: 'Parcial' },
              ]} />
              {d.tipo === 'Parcial' && (
                <Field label="Monto a acreditar (con ITBIS)" req className="mt-8" error={error?.detalles?.monto}>
                  <input className="input" inputMode="decimal" value={d.monto} onChange={(e) => setD({ ...d, monto: decimal(e.target.value) })} />
                </Field>
              )}
            </>
          )}
          {error && !error.detalles && <div className="alert alert-err mt-12">{error.message}</div>}
          <div className="row end mt-16">
            <button className="btn btn-ghost" onClick={onClose}>Cancelar <span className="kbd">Esc</span></button>
            <button className="btn btn-primary" disabled={enviando || !d.motivo || d.detalle.trim().length < 10 || (d.tipo === 'Parcial' && !esDebito && !(monto > 0))} onClick={enviar}>
              {enviando ? 'Enviando…' : 'Enviar solicitud'}
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}

/** Estado de la última solicitud de nota de crédito del documento. */
function EstadoSolicitudNc({ f, onCancelar }) {
  if (!f.nc_estado || f.nc_estado === 'Cancelada') return null
  return (
    <div className="xs mt-8">
      Nota de crédito {f.nc_tipo === 'Parcial' ? `parcial (${money(f.nc_monto)})` : 'total'}: <Badge color={{ Pendiente: 'yellow', Aprobada: 'green', Rechazada: 'red' }[f.nc_estado]}>{f.nc_estado === 'Pendiente' ? 'En revisión' : f.nc_estado}</Badge>
      {f.nc_respuesta && <div className="muted">{f.nc_respuesta}</div>}
      {f.nc_estado === 'Pendiente' && <button className="link-btn xs" onClick={() => onCancelar(f.nc_id)}>Cancelar solicitud</button>}
    </div>
  )
}

// FAC-P02 · Mis facturas  /  Pagos del cliente
export function MisFacturas() {
  const navigate = useNavigate()
  const facturas = useApi('/facturas/mias')
  const prestador = useSession().rol === 'Empleado' // el prestador solo recibe facturas de su membresía
  const [solicitarNc, setSolicitarNc] = useState(null)
  const [error, setError] = useState(null)
  const cancelarNc = async (id) => {
    if (!window.confirm('¿Cancelar la solicitud de nota de crédito?')) return
    setError(null)
    try { await post(`/facturas/solicitudes-nota-credito/${id}/cancelar`); facturas.recargar() } catch (e) { setError(e.message) }
  }
  return (
    <Page crumb="Inicio · Mis facturas" title="Mis facturas">
      <div className="card">
        <div className="card-title">Comprobantes fiscales electrónicos</div>
        {facturas.error && <div className="alert alert-err">{facturas.error.message}</div>}
        {error && <div className="alert alert-err mb-12">{error}</div>}
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Número</th><th>Documento</th><th>e-NCF</th><th>Fecha</th><th>Solicitud</th><th>Concepto</th><th className="num">ITBIS</th><th className="num">Total</th><th>Estado DGII</th><th /></tr></thead>
            <tbody>
              {(facturas.data || []).map((f) => (
                <tr key={f.numero_factura}>
                  <td className="bold">{f.numero_factura}</td><td><Documento f={f} /></td><td className="mono">{f.ncf || '—'}</td><td>{fecha(f.fecha_emision)}</td>
                  <td>{f.solicitud || (f.plan ? `Plan ${f.plan}` : '—')}</td><td>{f.concepto}</td>
                  <td className="num">{num(f.itbis)}</td><td className="num bold">{f.tipo_documento === 'Nota de crédito' ? '−' : ''}RD$ {num(f.total)}</td>
                  <td>{f.estado === 'Anulada' ? <Badge>Anulada</Badge> : <Badge>{f.estado_dgii || 'Pendiente e-NCF'}</Badge>}<EstadoSolicitudNc f={f} onCancelar={cancelarNc} /></td>
                  <td>
                    <div className="col" style={{ gap: 4, alignItems: 'flex-start' }}>
                      <button className="btn btn-primary btn-sm" onClick={() => navigate(`/facturas/${f.numero_factura}`)}>📄 Descargar {f.tipo_documento === 'Factura' ? 'factura' : 'nota'} (NCF)</button>
                      {f.puede_solicitar_nc && <button className="btn btn-outline btn-sm" onClick={() => setSolicitarNc(f)}>↩ Solicitar nota de crédito</button>}
                    </div>
                  </td>
                </tr>
              ))}
              {!facturas.data?.length && <tr><td colSpan={10} className="center muted">{facturas.cargando ? 'Cargando…' : prestador ? 'Aún no tienes facturas: aquí aparecen las de tu membresía cuando la pagues.' : 'Aún no tienes facturas.'}</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="xs muted mt-12">
          {prestador
            ? <>Aquí están las facturas que la plataforma te emite por tu <b>membresía</b>. Las facturas de los servicios que realizas se emiten al cliente; tus ganancias y comisiones están en <b>Mis ganancias</b>.</>
            : <>¿Te cobraron de más o el servicio no se realizó? Usa <b>Solicitar nota de crédito</b>; administración la revisa y te avisa.</>}
        </div>
      </div>
      {solicitarNc && <SolicitarNotaCredito factura={solicitarNc} onClose={() => setSolicitarNc(null)} onListo={facturas.recargar} />}
    </Page>
  )
}

// FAC-P01 / FAC-P02 · Representación impresa de la factura electrónica (Figura 46)
export function FacturaPDF() {
  const navigate = useNavigate()
  const { numero } = useParams()
  const f = useApi(`/facturas/${numero}`)
  const d = f.data

  const descargarXml = async () => {
    const r = await fetch(`/api/facturas/${numero}/xml`, { headers: { Authorization: `Bearer ${leerSesion()?.token}` } })
    if (!r.ok) return window.alert('No se pudo descargar el XML')
    const url = URL.createObjectURL(await r.blob())
    const a = document.createElement('a')
    a.href = url
    a.download = `${d.ncf}.xml`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (f.error) return <div className="pdf-bg"><div className="paper"><div className="alert alert-err">{f.error.message}</div><button className="btn btn-ghost mt-12" onClick={() => navigate(-1)}>← Volver</button></div></div>
  if (!d) return <div className="pdf-bg"><div className="paper muted">Cargando factura…</div></div>

  const titulo = (d.nombre_ecf || 'Factura electrónica').toUpperCase()
  const anuladaPor = d.modificaciones.find((m) => m.tipo_documento === 'Nota de crédito' && m.codigo_modificacion === 1)
  const sustituta = d.modificaciones.find((m) => m.tipo_documento === 'Factura')
  const rncComprador = d.rnc_comprador ?? d.rnc_cedula
  return (
    <div className="pdf-bg">
      <div className="row end" style={{ maxWidth: 820, margin: '0 auto 12px' }}>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate(-1)}>← Volver</button>
        {d.url_consulta && <a className="btn btn-ghost btn-sm" href={d.url_consulta} target="_blank" rel="noreferrer">🔎 Verificar en la DGII</a>}
        {d.tiene_xml && <button className="btn btn-ghost btn-sm" onClick={descargarXml}>⬇ XML firmado</button>}
        <button className="btn btn-primary btn-sm" onClick={() => window.print()}>⬇ Descargar / imprimir</button>
      </div>
      <div className="paper">
        {d.ambiente && d.ambiente !== 'eCF' && (
          <div className="alert alert-err mb-12 center"><b>DOCUMENTO DE PRUEBA</b> · ambiente {d.ambiente === 'Simulado' ? 'simulado' : `${d.ambiente} de la DGII`} · sin validez fiscal</div>
        )}
        {d.aviso && <div className="alert alert-warn mb-12">{d.aviso}</div>}
        {d.estado === 'Anulada' && (
          <div className="alert alert-err mb-12">
            {d.tipo_documento === 'Nota de débito' ? 'Nota de débito revertida por una nota de crédito.'
              : sustituta ? <>Factura sustituida por la factura de crédito fiscal <button className="link-btn" onClick={() => navigate(`/facturas/${sustituta.numero_factura}`)}>{sustituta.ncf || sustituta.numero_factura}</button>.</>
                : anuladaPor ? <>Factura anulada por la nota de crédito <button className="link-btn" onClick={() => navigate(`/facturas/${anuladaPor.numero_factura}`)}>{anuladaPor.ncf || anuladaPor.numero_factura}</button>.</>
                  : 'Documento anulado.'}
          </div>
        )}
        <div className="row between" style={{ alignItems: 'flex-start' }}>
          <div className="row">
            <div className="brand-logo" style={{ width: 44, height: 44, background: 'var(--green-800)', color: '#fff' }}>DS</div>
            <div><div className="bold" style={{ fontSize: 16, color: 'var(--green-800)' }}>{d.emisor.razon_social}</div>{d.emisor.nombre_comercial && d.emisor.nombre_comercial !== d.emisor.razon_social && <div className="xs">{d.emisor.nombre_comercial}</div>}<div className="xs muted">RNC: {d.emisor.rnc}</div></div>
          </div>
          <div className="right">
            <div className="bold" style={{ color: 'var(--green-800)', fontSize: 14 }}>{d.ncf ? titulo : `${d.tipo_documento.toUpperCase()} (pendiente de e-NCF)`}</div>
            {d.ncf && <div className="small">e-NCF: <b>{d.ncf}</b></div>}
            <div className="xs">Fecha de emisión: {fecha(d.fecha_emision)}</div>
            {d.fecha_vencimiento_secuencia && <div className="xs">Válida hasta: {dia(d.fecha_vencimiento_secuencia)}</div>}
            <div className="xs muted">Documento interno: {d.numero_factura}</div>
          </div>
        </div>
        <div className="xs muted mt-8">{[d.emisor.direccion, d.emisor.telefono, d.emisor.correo].filter(Boolean).join(' · ')}</div>

        <div className="grid g-2 mt-16" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
          <div className="small"><b>Cliente</b><br />{d.razon_social_comprador || d.razon_social || d.cliente}<br />{rncComprador ? `${String(rncComprador).replace(/\D/g, '').length === 9 ? 'RNC' : 'Cédula'}: ${formatoCedula(rncComprador)}` : 'Consumidor final'}<br />{d.direccion}</div>
          <div className="small"><b>Referencia</b><br />{d.solicitud ? `Solicitud: ${d.solicitud}` : 'Suscripción a plan'}<br />{d.prestador && <>Prestador: {d.prestador}<br /></>}{d.tipo_documento === 'Nota de crédito' ? 'Crédito a favor del cliente' : d.abonos?.length ? 'Pago en abonos: anticipo y saldo' : <>Pago: {d.metodo_pago}{d.referencia ? ` · ${d.referencia}` : ''} · {money(d.monto)}</>}</div>
        </div>

        {d.referencia && (
          <div className="small mt-12" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, background: 'var(--surface-2, #f7f8f7)' }}>
            <b>{d.tipo_documento === 'Factura' ? 'Sustituye a' : 'Comprobante modificado'}:</b>{' '}
            <span className="mono">{d.referencia.ncf}</span> ({TIPO_ECF[d.referencia.tipo_ecf] || d.referencia.tipo_ecf}) del {fecha(d.referencia.fecha)}
            <br /><b>Código de modificación:</b> {d.referencia.codigo} · {d.referencia.descripcion}
            {d.referencia.razon && <><br /><b>Razón:</b> {d.referencia.razon}</>}
          </div>
        )}

        <table className="table mt-16">
          <thead><tr><th>Cant.</th><th>Descripción</th><th className="num">Precio unit.</th><th className="num">ITBIS</th><th className="num">Valor</th></tr></thead>
          <tbody>{d.lineas.map((l, i) => <tr key={i}><td>{l.cantidad}</td><td>{l.descripcion}</td><td className="num">{num(l.precio_unitario)}</td><td className="num">{num(l.itbis_linea)}</td><td className="num">{num(l.total_linea)}</td></tr>)}</tbody>
        </table>

        <div className="row between mt-16" style={{ alignItems: 'flex-start' }}>
          {d.ncf ? (
            <div className="row" style={{ alignItems: 'flex-start' }}>
              {d.url_consulta ? <QrDgii url={d.url_consulta} size={100} /> : <QrFake seed={d.ncf} />}
              <div className="xs">
                <b>Código de seguridad:</b> {d.codigo_seguridad}<br />
                <b>Fecha de firma digital:</b> {d.fecha_firma || (d.fecha_envio ? fechaHora(d.fecha_envio) : '—')}<br />
                <b>Estado DGII:</b> {d.estado_dgii}<br />
                Escanee el código QR para verificar<br />este comprobante en el portal de la DGII.
              </div>
            </div>
          ) : <div className="xs muted">El e-NCF se asignará cuando haya una secuencia autorizada vigente.</div>}
          <div style={{ minWidth: 240 }} className="small">
            <div className="row between"><span>Subtotal</span><span>{num(d.subtotal)}</span></div>
            <div className="row between"><span>Descuento</span><span>{num(d.descuento)}</span></div>
            <div className="row between"><span>ITBIS (18%)</span><span>{num(d.itbis)}</span></div>
            <div className="divider" style={{ margin: '6px 0' }} />
            <div className="row between bold" style={{ fontSize: 14 }}><span>TOTAL RD$</span><span>{num(d.total)}</span></div>
            {d.abonos?.length > 0 && (
              <>
                <div className="divider" style={{ margin: '6px 0' }} />
                {d.abonos.map((a) => (
                  <div key={a.id_pago} className="row between">
                    <span>Abono · {a.tipo_pago === 'Anticipo' ? 'anticipo' : 'saldo'} ({a.metodo_pago}, {dia(a.fecha_pago)})</span><span>− {num(a.aplicado)}</span>
                  </div>
                ))}
                <div className={`row between bold ${d.pendiente > 0 ? '' : 'green'}`}>
                  <span>{d.pendiente > 0 ? 'PENDIENTE RD$' : 'PAGADA'}</span><span>{d.pendiente > 0 ? num(d.pendiente) : '✓'}</span>
                </div>
              </>
            )}
          </div>
        </div>
        {d.pendiente > 0 && d.estado === 'Emitida' && <div className="xs muted mt-8">El saldo pendiente se paga al finalizar el servicio y se abona a esta misma factura.</div>}
        {d.modificaciones.length > 0 && (
          <div className="xs mt-16">
            <b>Documentos relacionados:</b>{' '}
            {d.modificaciones.map((m, i) => (
              <span key={m.numero_factura}>{i > 0 && ' · '}{m.tipo_documento} <button className="link-btn" onClick={() => navigate(`/facturas/${m.numero_factura}`)}>{m.ncf || m.numero_factura}</button> ({money(m.total)}, {m.descripcion?.toLowerCase()})</span>
            ))}
          </div>
        )}
        <div className="xs muted center mt-20" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          Representación impresa de comprobante fiscal electrónico · Generado por el Sistema de Gestión Multiservicios
        </div>
      </div>
    </div>
  )
}

// FAC-P03 · Control de e-CF y secuencias (Figura 47)
export function Facturacion() {
  const navigate = useNavigate()
  const [f, setF] = useState('Todos')
  const FILTRO = { Todos: '', Aceptados: 'Aceptado', 'En proceso': 'En proceso', Rechazados: 'Rechazado' }
  const estado = useApi('/admin/facturacion/estado')
  const comp = useApi(`/admin/facturacion/comprobantes${FILTRO[f] ? `?estado=${encodeURIComponent(FILTRO[f])}` : ''}`)
  const secuencias = useApi(estado.data ? '/admin/facturacion/secuencias' : null)
  const [corregir, setCorregir] = useState(null)
  const [rnc, setRnc] = useState('')
  const [ocupado, setOcupado] = useState(null)
  const [aviso, setAviso] = useState(null)
  const [nuevaSec, setNuevaSec] = useState(null)
  const [nota, setNota] = useState(null)
  const [rango607, setRango607] = useState({ desde: isoDia().slice(0, 8) + '01', hasta: isoDia() })

  const accion = async (clave, fn, ok) => {
    setAviso(null)
    setOcupado(clave)
    try {
      const r = await fn()
      setAviso({ tipo: 'ok', texto: ok(r) })
      comp.recargar()
    } catch (e) {
      setAviso({ tipo: 'err', texto: e.message })
    } finally {
      setOcupado(null)
    }
  }
  const descargar607 = async () => {
    const r = await fetch(`/api/admin/facturacion/607?desde=${rango607.desde}&hasta=${rango607.hasta}`, { headers: { Authorization: `Bearer ${leerSesion()?.token}` } })
    if (!r.ok) return setAviso({ tipo: 'err', texto: 'No se pudo generar el 607' })
    const url = URL.createObjectURL(await r.blob())
    const a = document.createElement('a')
    a.href = url
    a.download = `607_${rango607.desde}_${rango607.hasta}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const e = estado.data
  const lista = comp.data?.comprobantes || []
  const pendientes = comp.data?.pendientes_encf || []
  const rechazados = lista.filter((c) => c.estado_dgii === 'Rechazado')

  return (
    <Page crumb="Administración · Facturación" title="Facturación electrónica (e-CF)">
      {/* Conexión con la plataforma e-CF */}
      <div className="card mb-16">
        <div className="row between wrap">
          <div className="row">
            <span style={{ fontSize: 26 }}>{e?.modo === 'proveedor' ? (e.conectado ? '🟢' : '🔴') : '🟡'}</span>
            <div>
              <div className="bold">
                {!e ? 'Consultando…' : e.modo === 'simulado' ? 'Modo simulado (sin envío a la DGII)'
                  : e.conectado ? 'Conectado a la plataforma de facturación electrónica' : 'Sin conexión con la plataforma e-CF'}
              </div>
              <div className="xs muted">
                {e?.modo === 'proveedor' && e.conectado && <>Ambiente <b>{e.ambiente || '—'}</b>{e.ambiente !== 'eCF' && ' (pruebas, sin validez fiscal)'} · {e.documentos} documentos en la plataforma</>}
                {e?.modo === 'proveedor' && !e.conectado && e.error}
                {e?.modo === 'simulado' && 'Configure ECF_API_URL y ECF_API_KEY en backend/.env para emitir comprobantes reales.'}
              </div>
            </div>
          </div>
          {e?.emisor && (
            <div className="small right">
              <div className="xs muted">Emisor registrado en la plataforma</div>
              <b>{e.emisor.razon_social}</b> · RNC {e.emisor.rnc}
            </div>
          )}
        </div>
      </div>

      {aviso && <div className={`alert ${aviso.tipo === 'ok' ? 'alert-ok' : 'alert-err'} mb-16`}>{aviso.texto}</div>}

      <SolicitudesNotaCredito onCambio={(texto, tipo = 'ok') => { setAviso({ tipo, texto }); comp.recargar() }} />

      {/* Secuencias */}
      <div className="card mb-16">
        <div className="row between mb-12">
          <div className="card-title" style={{ margin: 0 }}>Secuencias autorizadas por la DGII</div>
          <div className="row">
            {e?.modo === 'proveedor' && (
              <button className="btn btn-ghost btn-sm" disabled={ocupado === 'sync'}
                onClick={() => accion('sync', () => post('/admin/facturacion/secuencias/sincronizar'), (r) => { secuencias.recargar(); return r.avisos ? `Sincronizado · ${r.avisos} aviso(s) enviado(s) a administración` : 'Secuencias sincronizadas con la plataforma' })}>
                {ocupado === 'sync' ? 'Sincronizando…' : '↻ Sincronizar'}
              </button>
            )}
            {e && <button className="btn btn-outline btn-sm" onClick={() => setNuevaSec({ tipo_ecf: 'e31', desde: '', hasta: '', vencimiento: '' })}>＋ Registrar {e.modo === 'proveedor' ? 'rango autorizado' : 'secuencia'}</button>}
          </div>
        </div>
        {e?.modo === 'proveedor' ? (
          <MonitorSecuencias datos={secuencias.data} onEliminar={(sq) => window.confirm(`¿Eliminar el rango ${formatoNcfLocal(sq.tipo_ecf, sq.desde)} – ${formatoNcfLocal(sq.tipo_ecf, sq.hasta)}? Los comprobantes emitidos no cambian.`) &&
            accion('del', () => api(`/admin/facturacion/secuencias/${sq.id_secuencia}`, { metodo: 'DELETE' }), () => { secuencias.recargar(); return 'Rango eliminado' })} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Tipo</th><th>Desde</th><th>Hasta</th><th>Último usado</th><th className="num">Disponibles</th><th>Vencimiento</th><th style={{ width: 160 }}>Uso</th><th>Estado</th></tr></thead>
              <tbody>
                {(Array.isArray(secuencias.data) ? secuencias.data : []).map((sq) => (
                  <tr key={sq.id_secuencia}>
                    <td><b>{sq.tipo_ecf}</b> {TIPO_ECF[sq.tipo_ecf]}</td>
                    <td className="mono">{formatoNcfLocal(sq.tipo_ecf, sq.desde)}</td><td className="mono">{formatoNcfLocal(sq.tipo_ecf, sq.hasta)}</td>
                    <td className="mono">{sq.ultimo_usado >= sq.desde ? formatoNcfLocal(sq.tipo_ecf, sq.ultimo_usado) : '—'}</td>
                    <td className="num">{num0(sq.disponibles)}</td><td>{dia(sq.vencimiento)}</td>
                    <td><div className="bar"><span style={{ width: `${((sq.ultimo_usado - sq.desde + 1) / (sq.hasta - sq.desde + 1)) * 100}%` }} /></div></td>
                    <td><Badge>{sq.estado_actual}</Badge>{sq.alerta ? <span className="xs yellow-t"> ⚠</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Facturas sin e-CF */}
      {pendientes.length > 0 && (
        <div className="card mb-16" style={{ border: '1.5px solid var(--yellow-border)' }}>
          <div className="card-title">⚠ Pendientes de e-CF ({pendientes.length})</div>
          <table className="table">
            <thead><tr><th>Documento</th><th>Fecha</th><th className="num">Total</th><th>Último error</th><th /></tr></thead>
            <tbody>
              {pendientes.map((p) => (
                <tr key={p.numero_factura}>
                  <td className="bold">{p.numero_factura}<div className="xs muted">{p.tipo_documento}</div></td><td>{fecha(p.fecha_emision)}</td><td className="num">{num(p.total)}</td>
                  <td className="xs">{p.error_ecf || 'Sin secuencia disponible'}</td>
                  <td>{e?.modo === 'proveedor' && (
                    <button className="btn btn-primary btn-sm" disabled={ocupado === `p${p.id_factura}`}
                      onClick={() => accion(`p${p.id_factura}`, () => post(`/admin/facturacion/facturas/${p.id_factura}/emitir`), (r) => `${p.numero_factura}: ${r.ncf} · ${r.estado_dgii}`)}>
                      {ocupado === `p${p.id_factura}` ? 'Emitiendo…' : 'Reintentar emisión'}
                    </button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Comprobantes */}
      <div className="card">
        <div className="row between wrap mb-12">
          <div className="row wrap">
            <div className="card-title" style={{ margin: 0 }}>Comprobantes emitidos</div>
            <Chips valor={f} onChange={setF} opciones={['Todos', 'Aceptados', 'En proceso', { value: 'Rechazados', label: `Rechazados${rechazados.length && f === 'Todos' ? ` (${rechazados.length})` : ''}` }]} />
          </div>
          <div className="row wrap">
            <input className="input" type="date" style={{ width: 140 }} value={rango607.desde} onChange={(ev) => setRango607({ ...rango607, desde: ev.target.value })} />
            <input className="input" type="date" style={{ width: 140 }} value={rango607.hasta} onChange={(ev) => setRango607({ ...rango607, hasta: ev.target.value })} />
            <button className="btn btn-outline btn-sm" onClick={descargar607}>⬇ Exportar 607</button>
          </div>
        </div>
        {comp.error && <div className="alert alert-err">{comp.error.message}</div>}
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>e-NCF</th><th>Documento</th><th>Número</th><th>Cliente</th><th>RNC / Cédula</th><th className="num">ITBIS</th><th className="num">Total</th><th>Ambiente</th><th>Estado DGII</th><th>Acciones</th></tr></thead>
            <tbody>
              {lista.map((c) => (
                <tr key={c.id_ecf}>
                  <td className="bold mono">{c.ncf}</td>
                  <td><Documento f={c} />{c.estado_factura === 'Anulada' && <div><Badge>Anulada</Badge></div>}</td>
                  <td><button className="link-btn" onClick={() => navigate(`/facturas/${c.numero_factura}`)}>{c.numero_factura}</button><div className="xs muted">{fecha(c.fecha_emision)}</div></td>
                  <td>{c.cliente}</td><td className="mono">{c.rnc_cedula || '—'}</td>
                  <td className="num">{num(c.itbis)}</td><td className="num">{num(c.total)}</td>
                  <td className="xs">{c.ambiente || 'Simulado'}</td>
                  <td><Badge>{c.estado_dgii}</Badge>{c.mensaje_dgii && <div className="xs muted" style={{ maxWidth: 260 }}>{c.mensaje_dgii}</div>}</td>
                  <td className="nowrap">
                    <div className="col" style={{ gap: 4, alignItems: 'flex-start' }}>
                      {c.url_consulta && <a className="btn btn-ghost btn-sm" href={c.url_consulta} target="_blank" rel="noreferrer">🔎 DGII</a>}
                      {c.estado_dgii === 'En proceso' && (
                        <button className="btn btn-outline btn-sm" disabled={ocupado === `c${c.id_ecf}`}
                          onClick={() => accion(`c${c.id_ecf}`, () => post(`/admin/facturacion/ecf/${c.id_ecf}/consultar`), (r) => `${r.ncf}: ${r.estado_dgii}`)}>
                          {ocupado === `c${c.id_ecf}` ? 'Consultando…' : 'Consultar'}
                        </button>
                      )}
                      {c.estado_dgii === 'Rechazado' && <button className="btn btn-danger btn-sm" onClick={() => { setCorregir(c); setRnc(c.rnc_cedula || '') }}>Corregir y reenviar</button>}
                      {c.puede_nota_credito && (
                        <button className="btn btn-outline btn-sm" onClick={() => setNota({ c, tipo: 'Total', monto: '', razon: '' })}>
                          {c.tipo_documento === 'Nota de débito' ? 'Revertir (nota de crédito)' : 'Nota de crédito'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!lista.length && <tr><td colSpan={10} className="center muted">{comp.cargando ? 'Cargando…' : 'No hay comprobantes en este filtro.'}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {corregir && (
        <Modal titulo={`Corregir y reenviar ${corregir.ncf}`} onClose={() => setCorregir(null)}>
          <div className="alert alert-err mb-12 small">{corregir.mensaje_dgii || 'Rechazado por la DGII'}</div>
          <Field label="RNC / Cédula del comprador" hint="Se actualiza en la ficha del cliente antes de reenviar.">
            <input className="input" inputMode="numeric" value={rnc} onChange={(ev) => setRnc(rncCedula(ev.target.value))} />
          </Field>
          <div className="xs muted mt-8">{e?.modo === 'proveedor' ? 'Se envía de nuevo a la plataforma y la DGII asigna un nuevo e-NCF.' : 'El XML original se conserva para auditoría.'}</div>
          <div className="row end mt-16">
            <button className="btn btn-ghost" onClick={() => setCorregir(null)}>Cancelar <span className="kbd">Esc</span></button>
            <button className="btn btn-primary" disabled={ocupado === 'r'}
              onClick={() => { const c = corregir; setCorregir(null); accion('r', () => post(`/admin/facturacion/ecf/${c.id_ecf}/reenviar`, { rnc_cedula: rnc }), (r) => `Reenviado: ${r.ncf} · ${r.estado_dgii}`) }}>
              Reenviar a la DGII
            </button>
          </div>
        </Modal>
      )}

      {nota && (
        <Modal titulo={`Nota de crédito sobre ${nota.c.ncf}`} onClose={() => setNota(null)}>
          <div className="small mb-12">{nota.c.tipo_documento} {nota.c.numero_factura} · {nota.c.cliente} · {money(nota.c.total)}</div>
          {nota.c.tipo_documento === 'Nota de débito' ? (
            <div className="alert alert-info small mb-12">
              La DGII no permite que una nota modifique a otra. Se emite una nota de crédito sobre la factura original <b className="mono">{nota.c.origen_ncf}</b> por {money(nota.c.total)} y esta nota de débito queda anulada.
            </div>
          ) : (
            <>
              <Chips valor={nota.tipo} onChange={(tipo) => setNota({ ...nota, tipo })} opciones={[
                { value: 'Total', label: 'Total · anula el comprobante' }, { value: 'Parcial', label: 'Parcial · corrige el monto' },
              ]} />
              <div className="xs muted mt-8 mb-12">
                {nota.tipo === 'Total' ? 'Código de modificación 1. El comprobante queda anulado.' : `Código de modificación 3. Disponible para acreditar: ${money(nota.c.disponible_credito)} (con ITBIS).`}
              </div>
              {nota.tipo === 'Parcial' && (
                <Field label="Monto a acreditar (con ITBIS)" req>
                  <input className="input" inputMode="decimal" value={nota.monto} onChange={(ev) => setNota({ ...nota, monto: decimal(ev.target.value) })} />
                </Field>
              )}
            </>
          )}
          <Field label="Motivo" req hint="Aparece en el comprobante (máx. 90 caracteres)">
            <input className="input" maxLength={90} value={nota.razon} onChange={(ev) => setNota({ ...nota, razon: ev.target.value })} />
          </Field>
          <div className="row end mt-16">
            <button className="btn btn-ghost" onClick={() => setNota(null)}>Cancelar <span className="kbd">Esc</span></button>
            <button className="btn btn-primary" disabled={!nota.razon.trim() || (nota.tipo === 'Parcial' && !(Number(nota.monto) > 0)) || ocupado === 'n'}
              onClick={() => {
                const n = nota
                setNota(null)
                accion('n', () => post(`/admin/facturacion/facturas/${n.c.id_factura}/nota-credito`, { tipo: n.c.tipo_documento === 'Nota de débito' ? 'Total' : n.tipo, monto: n.monto, razon: n.razon }),
                  (r) => `Nota de crédito ${r.ncf || r.numero_factura} · ${r.estado_dgii || 'pendiente de e-NCF'}`)
              }}>
              Emitir nota de crédito
            </button>
          </div>
        </Modal>
      )}

      {nuevaSec && (
        <Modal titulo={e?.modo === 'proveedor' ? 'Registrar rango autorizado por la DGII' : 'Registrar secuencia autorizada'} onClose={() => setNuevaSec(null)}>
          {e?.modo === 'proveedor' && (
            <div className="alert alert-info small mb-12">
              Copie el rango de la autorización de la DGII (el mismo que cargó en la plataforma e-CF). El sistema no emite con él:
              lo usa para calcular cuántos e-NCF quedan y avisar antes de que se agote o venza. Ej.: E31<b>0000001001</b> a E31<b>0000005000</b> → desde 1001, hasta 5000.
            </div>
          )}
          <div className="form-grid">
            <Field label="Tipo"><select className="select" value={nuevaSec.tipo_ecf} onChange={(ev) => setNuevaSec({ ...nuevaSec, tipo_ecf: ev.target.value })}>{Object.entries(TIPO_ECF).map(([v, l]) => <option key={v} value={v}>{v} {l}</option>)}</select></Field>
            <Field label="Vencimiento"><input className="input" type="date" value={nuevaSec.vencimiento} onChange={(ev) => setNuevaSec({ ...nuevaSec, vencimiento: ev.target.value })} /></Field>
            <Field label="Desde (número)"><input className="input" inputMode="numeric" value={nuevaSec.desde} onChange={(ev) => setNuevaSec({ ...nuevaSec, desde: entero(ev.target.value, 10) })} /></Field>
            <Field label="Hasta (número)"><input className="input" inputMode="numeric" value={nuevaSec.hasta} onChange={(ev) => setNuevaSec({ ...nuevaSec, hasta: entero(ev.target.value, 10) })} /></Field>
          </div>
          <div className="row end mt-16">
            <button className="btn btn-ghost" onClick={() => setNuevaSec(null)}>Cancelar</button>
            <button className="btn btn-primary" disabled={!nuevaSec.desde || !nuevaSec.hasta || !nuevaSec.vencimiento}
              onClick={() => { const n = nuevaSec; setNuevaSec(null); accion('s', () => post('/admin/facturacion/secuencias', n), () => { secuencias.recargar(); return 'Secuencia registrada' }) }}>Registrar</button>
          </div>
        </Modal>
      )}
    </Page>
  )
}

const formatoNcfLocal = (tipo, n) => `E${tipo.slice(1)}${String(n).padStart(10, '0')}`

/** FAC-P04 · Bandeja de solicitudes de nota de crédito de los clientes (aprobar, rechazar, registrar devolución). */
function SolicitudesNotaCredito({ onCambio }) {
  const navigate = useNavigate()
  const [filtro, setFiltro] = useState('Pendiente')
  const lista = useApi(`/admin/facturacion/solicitudes-nota-credito?estado=${encodeURIComponent(filtro)}`)
  const [modal, setModal] = useState(null) // { accion: 'Aprobar' | 'Rechazar' | 'Devuelto' | 'Voucher', x, tipo, monto, texto }
  const [ocupado, setOcupado] = useState(false)
  const d = lista.data
  const responder = async () => {
    const m = modal
    setOcupado(true)
    try {
      if (m.accion === 'Devuelto') {
        await post(`/admin/facturacion/solicitudes-nota-credito/${m.x.id_solicitud_nc}/devuelto`, { referencia: m.texto })
        onCambio(`Devolución registrada para ${m.x.numero_factura}`)
      } else if (m.accion === 'Voucher') {
        const v = await post(`/admin/facturacion/solicitudes-nota-credito/${m.x.id_solicitud_nc}/voucher`)
        onCambio(`Voucher ${v.codigo} por ${money(v.monto)} emitido a ${m.x.cliente}; se le avisó con el número.`)
      } else {
        const r = await post(`/admin/facturacion/solicitudes-nota-credito/${m.x.id_solicitud_nc}/responder`,
          { decision: m.accion, respuesta: m.texto, tipo: m.tipo, monto: m.monto })
        onCambio(m.accion === 'Rechazar' ? `Solicitud de ${m.x.numero_factura} rechazada` : `Nota de crédito ${r.ncf || r.nota} · ${r.estado_dgii || 'pendiente de e-NCF'}${r.requiere_devolucion ? ' · queda pendiente devolver el dinero' : ''}`)
      }
      setModal(null)
      lista.recargar()
    } catch (e) {
      onCambio(e.message, 'err')
    } finally {
      setOcupado(false)
    }
  }
  if (!d) return null
  if (filtro === 'Pendiente' && !d.solicitudes.length && !d.por_devolver) {
    return <div className="xs muted mb-16">No hay solicitudes de nota de crédito pendientes. <button className="link-btn xs" onClick={() => setFiltro('Todas')}>Ver historial</button></div>
  }
  return (
    <div className="card mb-16" style={d.pendientes ? { border: '1.5px solid var(--yellow-border)' } : undefined}>
      <div className="row between wrap mb-12">
        <div className="card-title" style={{ margin: 0 }}>Solicitudes de nota de crédito</div>
        <Chips valor={filtro} onChange={setFiltro} opciones={[
          { value: 'Pendiente', label: `Pendientes${d.pendientes ? ` (${d.pendientes})` : ''}` },
          { value: 'Por devolver', label: `Por devolver${d.por_devolver ? ` (${d.por_devolver})` : ''}` },
          { value: 'Todas', label: 'Todas' },
        ]} />
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Fecha</th><th>Cliente</th><th>Documento</th><th>Motivo</th><th className="num">Solicita</th><th>Estado</th><th>Acciones</th></tr></thead>
          <tbody>
            {d.solicitudes.map((x) => (
              <tr key={x.id_solicitud_nc}>
                <td>{fecha(x.fecha_solicitud)}</td>
                <td>{x.cliente}<div className="xs muted">{x.email}</div></td>
                <td><button className="link-btn" onClick={() => navigate(`/facturas/${x.numero_factura}`)}>{x.numero_factura}</button><div className="xs mono">{x.ncf}</div><div className="xs muted">{x.solicitud ? `${x.solicitud} · ` : ''}{x.metodo_pago || ''}</div></td>
                <td><b>{x.motivo}</b><div className="xs" style={{ maxWidth: 280 }}>{x.detalle}</div></td>
                <td className="num">{x.tipo === 'Parcial' ? money(x.monto) : <>Total<div className="xs muted">{money(x.disponible_credito)}</div></>}</td>
                <td>
                  <Badge color={{ Pendiente: 'yellow', Aprobada: 'green', Rechazada: 'red' }[x.estado]}>{x.estado}</Badge>
                  {x.nota_numero && <div className="xs"><button className="link-btn xs" onClick={() => navigate(`/facturas/${x.nota_numero}`)}>{x.nota_ncf || x.nota_numero}</button> · {money(x.monto_acreditado)} · {x.nota_estado_dgii || 'pendiente'}</div>}
                  {x.requiere_devolucion && <div className="xs">{x.fecha_devolucion ? (String(x.referencia_devolucion).startsWith('VCH-') ? `Voucher · ${x.referencia_devolucion}` : `Devuelto · ${x.referencia_devolucion}`) : <span className="yellow-t">Devolución pendiente</span>}</div>}
                  {x.respuesta && <div className="xs muted" style={{ maxWidth: 220 }}>{x.respuesta}</div>}
                </td>
                <td>
                  <div className="col" style={{ gap: 4, alignItems: 'flex-start' }}>
                    {x.estado === 'Pendiente' && (
                      <>
                        <button className="btn btn-primary btn-sm" onClick={() => setModal({ accion: 'Aprobar', x, tipo: x.tipo, monto: x.monto ?? '', texto: '' })}>✓ Aprobar</button>
                        <button className="btn btn-danger btn-sm" onClick={() => setModal({ accion: 'Rechazar', x, texto: '' })}>✕ Rechazar</button>
                      </>
                    )}
                    {x.estado === 'Aprobada' && x.requiere_devolucion && !x.fecha_devolucion && (
                      <>
                        <button className="btn btn-outline btn-sm" onClick={() => setModal({ accion: 'Devuelto', x, texto: '' })}>💸 Marcar devuelto</button>
                        <button className="btn btn-outline btn-sm" onClick={() => setModal({ accion: 'Voucher', x, texto: '' })}>🎟️ Emitir voucher</button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {!d.solicitudes.length && <tr><td colSpan={7} className="center muted">No hay solicitudes en este filtro.</td></tr>}
          </tbody>
        </table>
      </div>

      {modal && (
        <Modal titulo={{ Aprobar: 'Aprobar y emitir nota de crédito', Rechazar: 'Rechazar solicitud', Devuelto: 'Registrar devolución', Voucher: 'Emitir voucher (saldo a favor)' }[modal.accion]} onClose={() => setModal(null)}>
          <div className="small mb-12">{modal.x.cliente} · {modal.x.numero_factura} · <span className="mono">{modal.x.ncf}</span></div>
          {modal.accion === 'Aprobar' && (
            <>
              {modal.x.tipo_documento === 'Nota de débito' ? (
                <div className="alert alert-info small mb-12">Se revierte la nota de débito completa con una nota de crédito sobre la factura original.</div>
              ) : (
                <>
                  <Chips valor={modal.tipo} onChange={(tipo) => setModal({ ...modal, tipo })} opciones={[
                    { value: 'Total', label: `Total · anula (${money(modal.x.disponible_credito)})` }, { value: 'Parcial', label: 'Parcial' },
                  ]} />
                  {modal.tipo === 'Parcial' && (
                    <Field label="Monto a acreditar (con ITBIS)" req className="mt-8" hint={`El cliente pidió ${modal.x.monto ? money(modal.x.monto) : 'el total'}. Disponible: ${money(modal.x.disponible_credito)}`}>
                      <input className="input" inputMode="decimal" value={modal.monto} onChange={(e) => setModal({ ...modal, monto: decimal(e.target.value) })} />
                    </Field>
                  )}
                </>
              )}
              <Field label="Mensaje para el cliente (opcional)" className="mt-8"><input className="input" maxLength={300} value={modal.texto} onChange={(e) => setModal({ ...modal, texto: e.target.value })} /></Field>
              {modal.x.estado_pago === 'Confirmado' && <div className="xs muted mt-8">El documento está pagado ({modal.x.metodo_pago}): quedará pendiente devolver el dinero al cliente.</div>}
            </>
          )}
          {modal.accion === 'Rechazar' && (
            <Field label="Respuesta al cliente" req hint="Explique el motivo del rechazo"><textarea className="textarea" maxLength={300} value={modal.texto} onChange={(e) => setModal({ ...modal, texto: e.target.value })} /></Field>
          )}
          {modal.accion === 'Voucher' && (
            <div className="alert alert-info small">
              En lugar de devolver el dinero, se emite un <b>voucher por {money(modal.x.monto_acreditado)}</b> a nombre de {modal.x.cliente}.
              Recibe el número por la app y el correo, y lo usa como forma de pago en su próximo servicio (total o parcial; el saldo que sobre queda para después).
            </div>
          )}
          {modal.accion === 'Devuelto' && (
            <Field label="Referencia de la devolución" req hint={`Reembolso en ${modal.x.metodo_pago || 'el método de pago'} por ${money(modal.x.monto_acreditado)}`}>
              <input className="input" maxLength={60} placeholder="Ej.: reembolso PayPal 4XK…, transferencia TRF-…" value={modal.texto} onChange={(e) => setModal({ ...modal, texto: e.target.value })} />
            </Field>
          )}
          <div className="row end mt-16">
            <button className="btn btn-ghost" onClick={() => setModal(null)}>Cancelar <span className="kbd">Esc</span></button>
            <button className={`btn ${modal.accion === 'Rechazar' ? 'btn-danger' : 'btn-primary'}`}
              disabled={ocupado || (!['Aprobar', 'Voucher'].includes(modal.accion) && !modal.texto.trim()) || (modal.accion === 'Aprobar' && modal.tipo === 'Parcial' && !(Number(String(modal.monto).replace(/,/g, '')) > 0))}
              onClick={responder}>
              {ocupado ? 'Procesando…' : { Aprobar: 'Emitir nota de crédito', Rechazar: 'Rechazar', Devuelto: 'Registrar', Voucher: 'Emitir voucher' }[modal.accion]}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

/** Secuencias con la plataforma e-CF: último e-NCF usado por tipo y saldo del rango autorizado registrado. */
function MonitorSecuencias({ datos, onEliminar }) {
  if (!datos?.tipos) return <div className="muted small">Consultando secuencias…</div>
  const alertas = datos.tipos.filter((t) => t.rango?.alerta)
  return (
    <>
      {alertas.length > 0 && (
        <div className="alert alert-warn mb-12">
          ⚠ Solicite nueva secuencia en la Oficina Virtual de la DGII para: <b>{alertas.map((t) => `${t.tipo_ecf} ${TIPO_ECF[t.tipo_ecf]}`).join(', ')}</b>, y cárguela en la plataforma e-CF (Documentos ECF › Secuencias).
        </div>
      )}
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Tipo</th><th>Último e-NCF usado</th><th>Rango autorizado</th><th className="num">Disponibles</th><th style={{ width: 150 }}>Uso</th><th>Vence</th><th>Estado</th><th /></tr></thead>
          <tbody>
            {datos.tipos.map((t) => {
              const r = t.rango
              const pct = r ? Math.min(100, Math.max(0, ((r.ultimo_usado - r.desde + 1) / (r.hasta - r.desde + 1)) * 100)) : 0
              return (
                <tr key={t.tipo_ecf}>
                  <td><b>{t.tipo_ecf}</b> {TIPO_ECF[t.tipo_ecf]}</td>
                  <td className="mono">{t.ultimo_ncf || '—'}<div className="xs muted">{t.emitidos_sistema} emitidos por el sistema</div></td>
                  <td className="mono">{r ? <>{formatoNcfLocal(t.tipo_ecf, r.desde)}<br />{formatoNcfLocal(t.tipo_ecf, r.hasta)}</> : <span className="xs muted">Sin registrar</span>}</td>
                  <td className="num">{r ? num0(Math.max(r.disponibles, 0)) : '—'}</td>
                  <td>{r && <div className="bar"><span style={{ width: `${pct}%`, ...(r.alerta ? { background: 'var(--yellow, #e8a317)' } : {}) }} /></div>}</td>
                  <td>{r?.vence || t.vencimiento_informado ? dia(r?.vence || t.vencimiento_informado) : '—'}{t.vencimiento_informado && <div className="xs muted">informado por la DGII</div>}</td>
                  <td>{r ? <><Badge>{r.estado_actual}</Badge>{r.alerta ? <span className="xs yellow-t"> ⚠ por agotarse o vencer</span> : null}</> : <span className="xs muted">Registre el rango para monitorearlo</span>}</td>
                  <td>{r && <button className="link-btn xs" onClick={() => onEliminar(r)}>Eliminar</button>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="xs muted mt-8">
        Ambiente <b>{datos.ambiente || '—'}</b>. La plataforma asigna el e-NCF en cada envío; el último número se confirma en la plataforma (incluye los usados desde otros sistemas con la misma cuenta).
        Se sincroniza cada 6 horas y avisa a administración cuando queda menos del 10 % del rango o vence en menos de 30 días.
      </div>
    </>
  )
}

