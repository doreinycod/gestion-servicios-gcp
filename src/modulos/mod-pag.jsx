// MOD-PAG · Gestión de Pagos
// PAG-P01 Checkout y recibo · PAG-P02 PayPal · PAG-P03 Tarjeta · PAG-P04 Transferencia · PAG-P05 Cobro en efectivo · PAG-P06 Conciliación
import { useState, useEffect } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Page } from '../components/Layout'
import { num, num0, money, dia, fecha, fechaHora, isoDia } from '../lib/format'
import { Badge, Kpi, Modal, Field, Chips } from '../components/ui'
import { get, leerSesion, post, put } from '../lib/api'
import { useApi } from '../lib/useApi'
import { useSession } from '../components/session'
import { rncCedula, tarjeta as numTarjeta, vencimiento, digitos, letras, referencia, decimal } from '../lib/filtros'

// PAG-P01 Checkout · PAG-P02 PayPal · PAG-P03 Tarjeta · PAG-P04 Transferencia (Figuras 42 y 43)
const METODOS = [
  { id: 'PayPal', icono: '🅿️', sub: 'Confirmación inmediata' },
  { id: 'Tarjeta', icono: '💳', sub: 'Visa / Mastercard' },
  { id: 'Transferencia', icono: '🏦', sub: 'Verificación manual' },
  { id: 'Efectivo', icono: '💵', sub: 'Al prestador' },
  { id: 'Voucher', icono: '🎟️', sub: 'Saldo a favor' },
]
// Con voucher, el resto (si no lo cubre todo) se paga con uno de estos
const METODOS_RESTO = ['PayPal', 'Tarjeta', 'Transferencia']

/**
 * PAG-P01 · Comprobante fiscal del cobro: consumo (e32) o crédito fiscal (e31).
 * El crédito fiscal exige RNC/cédula válido en la DGII; la elección se guarda en la solicitud.
 */
function ComprobanteFiscal({ d, codigo, onListo }) {
  const inicial = d.comprobante?.tipo || d.tipo_ecf
  const [tipo, setTipo] = useState(inicial)
  const [rnc, setRnc] = useState(d.comprobante?.rnc || (d.cliente.tipo_cliente === 'Empresa' ? d.cliente.rnc_cedula || '' : ''))
  const [razon, setRazon] = useState(d.comprobante?.razon_social || '')
  // e31 vigente: elegido antes en la solicitud, o automático por ser empresa con RNC
  const [guardado, setGuardado] = useState(inicial === 'e31'
    ? { rnc: String(d.comprobante?.rnc || d.cliente.rnc_cedula || '').replace(/\D/g, ''), razon_social: d.comprobante?.razon_social || d.cliente.razon_social }
    : null)
  const [ocupado, setOcupado] = useState(false)
  const [error, setError] = useState(null)

  const elegir = async (t) => {
    setError(null)
    setTipo(t)
    if (t === 'e32') {
      setOcupado(true)
      try { await put(`/pagos/comprobante/${codigo}`, { tipo: 'e32' }); setGuardado(null); onListo(true) } catch (e) { setError(e.message) } finally { setOcupado(false) }
    } else {
      onListo(!!guardado)
    }
  }
  const validar = async () => {
    setError(null)
    setOcupado(true)
    try {
      const r = await put(`/pagos/comprobante/${codigo}`, { tipo: 'e31', rnc, razon_social: razon })
      setGuardado(r)
      setRazon(r.razon_social)
      onListo(true)
    } catch (e) {
      setError(e.message)
      onListo(false)
    } finally {
      setOcupado(false)
    }
  }

  return (
    <>
      <div className="label mt-16 mb-8">¿Qué comprobante fiscal necesitas?</div>
      <div className="col" style={{ gap: 8 }}>
        {[['e32', 'Consumo (e32)', 'Para personas: no da derecho a crédito fiscal'], ['e31', 'Crédito fiscal (e31)', 'Para empresas o negocios: requiere RNC o cédula']].map(([v, t, sub]) => (
          <label key={v} className={`option-card ${tipo === v ? 'selected' : ''}`} style={{ cursor: 'pointer' }}>
            <input type="radio" name="comprobante" checked={tipo === v} disabled={ocupado} onChange={() => elegir(v)} />
            <div><div className="semibold small">{t}</div><div className="xs muted">{sub}</div></div>
          </label>
        ))}
      </div>
      {tipo === 'e31' && (
        <div className="mt-12">
          {guardado && guardado.rnc === rnc.replace(/\D/g, '') ? (
            <div className="alert alert-ok small">✓ Factura a nombre de <b>{guardado.razon_social}</b> · RNC/Cédula {guardado.rnc} <button className="link-btn xs" onClick={() => { setGuardado(null); onListo(false) }}>Cambiar</button></div>
          ) : (
            <>
              <Field label="RNC o cédula" req hint="Se valida con la DGII y se usa la razón social registrada">
                <div className="row">
                  <input className="input" inputMode="numeric" value={rnc} placeholder="1-32-45678-5" onChange={(e) => { setRnc(rncCedula(e.target.value)); onListo(false) }} />
                  <button className="btn btn-primary btn-sm" disabled={ocupado || !rnc.trim()} onClick={validar}>{ocupado ? 'Validando…' : 'Validar'}</button>
                </div>
              </Field>
              <div className="xs muted">Debes validar el RNC antes de pagar.</div>
            </>
          )}
        </div>
      )}
      {error && <div className="alert alert-err small mt-8">{error}</div>}
      {d.facturas_previas > 0 && <div className="xs muted mt-8">Las facturas ya emitidas de esta solicitud no cambian.</div>}
    </>
  )
}

export function Pagar() {
  const navigate = useNavigate()
  const { codigo } = useParams()
  const [params] = useSearchParams()
  const co = useApi(`/pagos/checkout/${codigo}`)
  const [metodo, setMetodo] = useState('PayPal')
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState('')
  const [tarjeta, setTarjeta] = useState({ numero: '', venc: '', cvv: '', nombre: '' })
  const [trf, setTrf] = useState({ referencia: '', fecha: isoDia(), archivo: null })
  const [enviado, setEnviado] = useState(false)
  const [comprobanteListo, setComprobanteListo] = useState(true)
  const [vale, setVale] = useState(null) // voucher aplicado: { codigo, saldo, aplicado, resto, saldo_despues }
  const [codigoVale, setCodigoVale] = useState('')
  const [metodoResto, setMetodoResto] = useState('PayPal')
  const d = co.data

  if (co.cargando && !d) return <Page crumb={`Mis solicitudes · ${codigo} · Pago`} title="Pagar servicio"><div className="card muted">Cargando…</div></Page>
  if (co.error) {
    return (
      <Page crumb={`Mis solicitudes · ${codigo} · Pago`} title="Pagar servicio">
        <div className="alert alert-warn">{co.error.message}</div>
        <button className="btn btn-outline mt-12" onClick={() => navigate(`/seguimiento/${codigo}`)}>Ver la solicitud</button>
      </Page>
    )
  }

  // Con voucher aplicado: si cubre todo se paga solo con él; si no, el resto con el método elegido
  const conVale = metodo === 'Voucher' && vale
  const metodoActivo = metodo === 'Voucher' ? (vale && vale.resto > 0 ? metodoResto : 'Voucher') : metodo
  const aPagar = conVale ? vale.resto : d.total

  // Crea el registro en pagos (Pendiente) con v_metodoPagoTemp
  const crearPago = () => {
    if (!comprobanteListo) return Promise.reject(new Error('Valida el RNC del comprobante de crédito fiscal o elige consumo'))
    return post('/pagos', { codigo, metodo_pago: metodoActivo, voucher: conVale ? vale.codigo : undefined })
  }

  const aplicarVale = async () => {
    setError('')
    setVale(null)
    try { setVale(await get(`/pagos/voucher/${encodeURIComponent(codigoVale.trim())}?solicitud=${codigo}`)) } catch (e) { setError(e.message) }
  }
  const pagarConVale = async () => {
    setError('')
    setEnviando(true)
    try {
      const p = await crearPago()
      navigate(`/pagos/recibo/${p.id_pago}`)
    } catch (e) {
      setError(e.message)
      setEnviando(false)
    }
  }

  const pagarPaypal = async () => {
    setError('')
    setEnviando(true)
    try {
      const p = await crearPago()
      window.location.href = p.aprobar_url // ventana segura de PayPal; vuelve a /pagos/paypal/retorno
    } catch (e) {
      setError(e.message)
      setEnviando(false)
    }
  }

  const pagarTarjeta = async (e) => {
    e.preventDefault()
    setError('')
    const digitos = tarjeta.numero.replace(/\D/g, '')
    if (digitos.length < 13) return setError('Número de tarjeta inválido')
    setEnviando(true)
    try {
      const p = await crearPago()
      // Solo se envían los últimos 4 dígitos: los datos de la tarjeta los procesa la pasarela (PCI-DSS)
      await post(`/pagos/${p.id_pago}/tarjeta`, { ultimos4: digitos.slice(-4) })
      navigate(`/pagos/recibo/${p.id_pago}`)
    } catch (e2) {
      setError(e2.message)
    } finally {
      setEnviando(false)
    }
  }

  const enviarTransferencia = async () => {
    setError('')
    if (!/^[A-Za-z0-9-]{4,60}$/.test(trf.referencia)) return setError('Indique el número de transferencia')
    if (!trf.archivo) return setError('Adjunte el comprobante (JPG, PNG o PDF hasta 5 MB)')
    if (trf.archivo.size > 5 * 1024 * 1024) return setError('Tipo o tamaño de archivo no permitido')
    setEnviando(true)
    try {
      const p = await crearPago()
      const fd = new FormData()
      fd.append('referencia', trf.referencia)
      fd.append('fecha', trf.fecha)
      fd.append('comprobante', trf.archivo)
      await post(`/pagos/${p.id_pago}/transferencia`, fd)
      setEnviado(true)
    } catch (e) {
      setError(e.message)
    } finally {
      setEnviando(false)
    }
  }

  return (
    <Page crumb={`Mis solicitudes · ${codigo} · Pago`} title={{ Anticipo: 'Pagar anticipo (50 %)', Saldo: 'Pagar saldo (50 %)', Total: 'Pagar servicio', Cargo: 'Pagar cargo adicional' }[d.tipo_pago]}>
      {d.tipo_pago === 'Anticipo' && <div className="alert alert-info mb-16">Pagas ahora el <b>50 % de anticipo</b> para confirmar la visita. El otro 50 % se paga cuando el servicio termine.</div>}
      {d.tipo_pago === 'Saldo' && <div className="alert alert-info mb-16">El servicio terminó. Pagas el <b>saldo</b>: el 50 % restante más los materiales que agregó el prestador.</div>}
      {d.tipo_pago === 'Cargo' && d.cargo && <div className="alert alert-info mb-16">Pagas el <b>cargo adicional</b> que aceptaste: {d.cargo.descripcion}. {d.cargo.motivo && <span className="muted">«{d.cargo.motivo}»</span>} Se factura con una <b>nota de débito electrónica</b> ligada a la factura del servicio.</div>}
      {params.get('cancelado') && <div className="alert alert-warn mb-16">Cancelaste el pago en PayPal. Puedes intentarlo de nuevo o elegir otro método.</div>}
      <div className="split">
        <div className="card">
          <div className="card-title">Elige tu método de pago</div>
          <div className="grid g-4" style={{ gap: 10 }}>
            {METODOS.map((m) => (
              <label key={m.id} className={`option-card ${metodo === m.id ? 'selected' : ''}`} style={{ flexDirection: 'column', gap: 4 }}>
                <input type="radio" hidden checked={metodo === m.id} onChange={() => { setMetodo(m.id); setError('') }} />
                <span style={{ fontSize: 20 }}>{m.icono}</span>
                <span className="semibold">{m.id}</span>
                <span className="xs muted">{m.sub}</span>
              </label>
            ))}
          </div>

          {metodo === 'Voucher' && (
            <div className="mt-16">
              <b>🎟️ Pagar con voucher</b>
              <div className="small muted mt-8 mb-8">Escribe el número del voucher que te emitimos (saldo a favor de una nota de crédito o un reembolso).</div>
              <div className="row" style={{ maxWidth: 440 }}>
                <input className="input mono" placeholder="VCH-XXXXXXXX" value={codigoVale} onChange={(e) => { setCodigoVale(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20)); setVale(null) }} />
                <button className="btn btn-outline" disabled={codigoVale.trim().length < 6} onClick={aplicarVale}>Aplicar</button>
              </div>
              {vale && (
                <div className="card mt-12 small" style={{ background: 'var(--green-50)', padding: 12 }}>
                  <div className="row between"><span>Saldo del voucher <span className="mono">{vale.codigo}</span></span><b>{money(vale.saldo)}</b></div>
                  <div className="row between"><span>Se aplica a este cobro</span><b>− {money(vale.aplicado)}</b></div>
                  <div className="row between"><span>Te queda en el voucher</span><span>{money(vale.saldo_despues)}</span></div>
                  <div className="row between bold mt-8"><span>{vale.resto > 0 ? 'Resto por pagar' : 'Total a pagar'}</span><span>{money(vale.resto)}</span></div>
                </div>
              )}
              {vale && vale.resto === 0 && (
                <div className="row end mt-12"><button className="btn btn-primary btn-lg" disabled={enviando || !comprobanteListo} onClick={pagarConVale}>{enviando ? 'Procesando…' : `Pagar con voucher ${money(vale.aplicado)}`}</button></div>
              )}
              {vale && vale.resto > 0 && (
                <>
                  <div className="label mt-16 mb-8">El voucher no cubre todo: ¿cómo pagas los {money(vale.resto)} restantes?</div>
                  <Chips valor={metodoResto} onChange={(m) => { setMetodoResto(m); setError('') }} opciones={METODOS_RESTO} />
                </>
              )}
            </div>
          )}

          {metodoActivo === 'PayPal' && (metodo !== 'Voucher' || conVale) && (
            <div className="mt-16">
              <div className="alert alert-info">
                {conVale
                  ? <>PayPal cobra en dólares el resto después del voucher: <b>US$ {num(Math.round(aPagar / d.tasa_usd * 100) / 100)}</b> (tasa RD$ {num(d.tasa_usd)} = US$ 1.00). Tu factura se emite por {money(d.total)}.</>
                  : <>PayPal cobra en dólares. Monto: <b>US$ {num(d.total_usd)}</b> (tasa RD$ {num(d.tasa_usd)} = US$ 1.00 del día). Tu factura se emite en pesos dominicanos por {money(d.total)}.</>}
              </div>
              {d.paypal_simulado && <div className="alert alert-warn mt-12">Modo simulado: falta configurar PAYPAL_CLIENT_SECRET en el backend, así que el pago no llegará a PayPal.</div>}
              <div style={{ maxWidth: 360, margin: '18px auto 0' }} className="col">
                <button className="btn btn-paypal btn-lg btn-block" disabled={enviando || !comprobanteListo} onClick={pagarPaypal}>{enviando ? 'Abriendo PayPal…' : <>Pay<span>Pal</span></>}</button>
                <div className="xs muted center">Serás llevado a la página segura de PayPal para aprobar el pago y luego regresarás aquí.</div>
              </div>
            </div>
          )}

          {metodoActivo === 'Tarjeta' && (
            <form className="mt-16" style={{ maxWidth: 440 }} onSubmit={pagarTarjeta}>
              <div className="row between mb-8"><b>💳 Pago con tarjeta</b><span className="xs muted">Procesado por Azul · 3-D Secure</span></div>
              <div className="xs muted mb-12">Formulario seguro alojado por la pasarela (los datos no pasan por nuestro servidor). Prueba: una tarjeta que termine en 0002 se declina.</div>
              <div className="col">
                <Field label="Número de tarjeta"><input className="input" inputMode="numeric" autoComplete="cc-number" value={tarjeta.numero} onChange={(e) => setTarjeta({ ...tarjeta, numero: numTarjeta(e.target.value) })} placeholder="4111 1111 1111 1111" /></Field>
                <div className="form-grid">
                  <Field label="Vencimiento"><input className="input" inputMode="numeric" autoComplete="cc-exp" value={tarjeta.venc} onChange={(e) => setTarjeta({ ...tarjeta, venc: vencimiento(e.target.value) })} placeholder="MM/AA" /></Field>
                  <Field label="CVV"><input className="input" type="password" inputMode="numeric" autoComplete="cc-csc" value={tarjeta.cvv} onChange={(e) => setTarjeta({ ...tarjeta, cvv: digitos(e.target.value, 4) })} /></Field>
                </div>
                <Field label="Nombre en la tarjeta"><input className="input" autoComplete="cc-name" value={tarjeta.nombre} onChange={(e) => setTarjeta({ ...tarjeta, nombre: letras(e.target.value).toUpperCase() })} /></Field>
                <button className="btn btn-primary btn-lg" disabled={enviando || !comprobanteListo}>{enviando ? 'Procesando…' : `Pagar ${money(aPagar)}`}</button>
              </div>
            </form>
          )}

          {metodoActivo === 'Transferencia' && (
            <div className="mt-16">
              <b>🏦 Pago por transferencia bancaria</b>
              <div className="small muted mt-8 mb-8">Transfiere el total a una de estas cuentas e indica la referencia:</div>
              <table className="table">
                <thead><tr><th>Banco</th><th>Tipo</th><th>Cuenta</th></tr></thead>
                <tbody>
                  <tr><td>Banco Popular</td><td>Corriente RD$</td><td className="bold">812-345678-9</td></tr>
                  <tr><td>Banreservas</td><td>Corriente RD$</td><td className="bold">240-012345-6</td></tr>
                  <tr><td>BHD</td><td>Corriente RD$</td><td className="bold">1234567-001-2</td></tr>
                </tbody>
              </table>
              <div className="xs muted mt-8">A nombre de: Directorio Servicios, SRL · RNC 1-32-45678-9</div>
              <div className="row between card mt-8" style={{ padding: 10, background: 'var(--green-50)' }}>
                <span className="small">Referencia: <b className="mono">{codigo}</b></span><span className="small">Monto: <b>{money(aPagar)}</b>{conVale ? ' (después del voucher)' : ''}</span>
              </div>
              {enviado ? (
                <div className="alert alert-ok mt-12">✅ Comprobante recibido. Tu pago quedó <b>En verificación</b>; administración lo concilia en un máximo de 24 h hábiles y te llegará la factura.</div>
              ) : (
                <>
                  <div className="form-grid mt-12">
                    <Field label="No. de transferencia"><input className="input" value={trf.referencia} onChange={(e) => setTrf({ ...trf, referencia: referencia(e.target.value) })} placeholder="TRF-88231457" /></Field>
                    <Field label="Fecha"><input className="input" type="date" value={trf.fecha} onChange={(e) => setTrf({ ...trf, fecha: e.target.value })} /></Field>
                  </div>
                  <div className="label mt-12 mb-8">Adjuntar comprobante</div>
                  <label className="drop">
                    {trf.archivo ? <>📎 <b>{trf.archivo.name}</b> ({Math.round(trf.archivo.size / 1024)} KB) ✓</> : '📎 Haz clic para elegir el comprobante'}
                    <br /><span className="xs muted">JPG, PNG o PDF · máximo 5 MB</span>
                    <input type="file" hidden accept=".jpg,.jpeg,.png,.pdf" onChange={(e) => setTrf({ ...trf, archivo: e.target.files[0] || null })} />
                  </label>
                  <div className="row end mt-12"><button className="btn btn-primary" disabled={enviando || !comprobanteListo} onClick={enviarTransferencia}>{enviando ? 'Enviando…' : 'Adjuntar comprobante y enviar'}</button></div>
                </>
              )}
            </div>
          )}

          {metodo === 'Efectivo' && (
            <div className="mt-16 col">
              <div className="alert alert-info">💵 Paga en efectivo directamente al prestador. Él registrará el cobro con el número de recibo y el pago quedará <b>En verificación</b> hasta que administración lo concilie.</div>
              <div className="kv"><div>Monto a entregar</div><div className="bold">{money(d.total)}</div></div>
            </div>
          )}
          {!comprobanteListo && <div className="alert alert-warn mt-12">Para pagar, valida el RNC del comprobante de crédito fiscal (a la derecha) o elige consumo.</div>}
          {error && <div className="alert alert-err mt-12">{error}</div>}
        </div>

        <div className="col" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-title" style={{ marginBottom: 2 }}>{{ Anticipo: 'Detalle del anticipo (50 %)', Saldo: 'Detalle del saldo (50 %)', Total: 'Detalle del cobro', Cargo: 'Detalle del cargo adicional' }[d.tipo_pago]}</div>
            <div className="xs muted mb-12">Solicitud {codigo}{d.fecha_completado ? ` · Completado ${dia(d.fecha_completado)}` : ''}</div>
            <table className="table">
              <thead><tr><th>Descripción</th><th className="num">Cant.</th><th className="num">Precio</th><th className="num">Importe</th></tr></thead>
              <tbody>{d.lineas.map((l, i) => <tr key={i}><td>{l.descripcion}</td><td className="num">{l.cantidad}</td><td className="num">{num(l.precio)}</td><td className="num">{num(l.importe)}</td></tr>)}</tbody>
            </table>
            <div className="small col mt-12" style={{ gap: 3 }}>
              <div className="row between"><span>Subtotal</span><span>{num(d.subtotal)}</span></div>
              {d.descuento > 0 && <div className="row between"><span>Descuento plan {d.plan}</span><span>− {num(d.descuento)}</span></div>}
              <div className="row between"><span>ITBIS 18%</span><span>{num(d.itbis)}</span></div>
              <div className="row between bold" style={{ fontSize: 15 }}><span>{{ Total: 'Total a pagar', Cargo: 'Cargo a pagar' }[d.tipo_pago] || `${d.tipo_pago} a pagar`}</span><span>{money(d.total)}</span></div>
            </div>
            {['Anticipo', 'Saldo'].includes(d.tipo_pago) && (
              <div className="small col mt-12" style={{ gap: 3, background: 'var(--green-50)', borderRadius: 8, padding: '8px 10px' }}>
                <div className="row between"><span>Total del servicio</span><span>{money(d.total_servicio)}</span></div>
                {d.anticipo_pagado
                  ? <div className="row between"><span>Anticipo ya pagado ({d.anticipo_pagado.estado.toLowerCase()})</span><span>− {money(d.anticipo_pagado.monto)}</span></div>
                  : <div className="row between"><span>Saldo al finalizar</span><span>≈ {money(d.total_servicio - d.total)}</span></div>}
              </div>
            )}
            {d.tipo_pago === 'Cargo' ? (
              <>
                <div className="label mt-16 mb-8">Comprobante fiscal</div>
                <div className="option-card selected"><div><div className="semibold small">Nota de débito (e33)</div><div className="xs muted">Con los mismos datos fiscales de la factura del servicio</div></div></div>
              </>
            ) : <ComprobanteFiscal d={d} codigo={codigo} onListo={setComprobanteListo} />}
          </div>
          <div className="xs muted">🔒 No almacenamos datos de tarjeta. Pagos procesados por PayPal y Azul/CardNet (PCI-DSS).</div>
        </div>
      </div>
    </Page>
  )
}

// PAG-P01 · Recibo de pago confirmado (Figura 44)
export function Recibo() {
  const navigate = useNavigate()
  const { id } = useParams()
  const { usuario } = useSession()
  const r = useApi(`/pagos/${id}/recibo`)
  const { rol } = useSession()
  const d = r.data
  return (
    <Page crumb={`Pagos · ${d ? d.codigo_pago : ''} · Recibo`} title={d?.estado === 'Confirmado' ? 'Pago confirmado' : 'Recibo de pago'}>
      {r.error && <div className="alert alert-err">{r.error.message}</div>}
      {d && (
        <div className="card center" style={{ maxWidth: 560, margin: '10px auto', padding: 30 }}>
          <div style={{ fontSize: 44 }}>{d.estado === 'Confirmado' ? '✅' : '⏳'}</div>
          <h2 style={{ fontSize: 19 }}>{d.estado === 'Confirmado' ? '¡Pago realizado con éxito!' : `Pago ${d.estado.toLowerCase()}`}</h2>
          <p className="small muted">Gracias, {usuario?.nombreCorto?.split(' ')[0]}. Te enviamos el recibo y la factura a {d.email}</p>
          <div className="kv mt-16" style={{ textAlign: 'left', maxWidth: 420, margin: '16px auto 0' }}>
            <div>Pago</div><div className="bold">{d.codigo_pago} · {{ Total: 'Pago único', Anticipo: 'Anticipo 50 %', Saldo: 'Saldo 50 %', Cargo: 'Cargo adicional' }[d.tipo_pago]}</div>
            {d.codigo_seguimiento && <><div>Solicitud</div><div className="bold">{d.codigo_seguimiento}</div></>}
            <div>Método</div><div>{d.metodo_pago}{d.referencia && d.metodo_pago !== 'Voucher' ? ` · ${d.metodo_pago === 'PayPal' ? 'Capture' : 'Ref.'} ${d.referencia}` : ''}</div>
            {d.voucher && <><div>Voucher</div><div><span className="mono">{d.voucher}</span> · {money(d.monto_voucher)}{d.metodo_pago !== 'Voucher' ? ` (resto ${money(d.monto - d.monto_voucher)} por ${d.metodo_pago})` : ''}</div></>}
            <div>Fecha</div><div>{fechaHora(d.fecha_pago)}</div>
            <div>Total</div><div><b>{money(d.monto)}</b>{d.monto_usd ? ` (US$ ${num(d.monto_usd)})` : ''}</div>
            <div>Estado del pago</div><div><Badge>{d.estado}</Badge></div>
            <div>e-NCF</div><div>{d.ncf ? <><b className="mono">{d.ncf}</b> · <Badge>{d.estado_dgii === 'Aceptado' ? 'Aceptado DGII' : d.estado_dgii}</Badge></> : <span className="muted">Se emite al confirmar el pago</span>}</div>
          </div>
          <div className="row mt-20" style={{ justifyContent: 'center' }}>
            {d.numero_factura && <button className="btn btn-primary" onClick={() => navigate(`/facturas/${d.numero_factura}`)}>📄 Descargar factura (NCF)</button>}
            {rol === 'Empleado'
              ? <button className="btn btn-outline" onClick={() => navigate('/prestador/membresia')}>Ver mi membresía</button>
              : <button className="btn btn-outline" onClick={() => navigate('/mis-solicitudes')}>Ver mis solicitudes</button>}
          </div>
        </div>
      )}
    </Page>
  )
}

export function PagosCliente() {
  const navigate = useNavigate()
  const pagos = useApi('/pagos/mios')
  const sol = useApi('/solicitudes/mias')
  const vouchers = useApi('/pagos/vouchers/mios')
  const porPagar = (sol.data || []).filter((s) => s.por_pagar)
  const conSaldo = (vouchers.data || []).filter((v) => v.estado === 'Activo' && v.saldo > 0)
  return (
    <Page crumb="Inicio · Pagos" title="Mis pagos">
      {vouchers.data?.length > 0 && (
        <div className="card mb-16">
          <div className="card-title">🎟️ Mis vouchers (saldo a favor)</div>
          {conSaldo.length > 0 && <div className="small mb-8">Tienes <b>{money(conSaldo.reduce((t, v) => t + Number(v.saldo), 0))}</b> a favor. Al pagar un servicio elige <b>Voucher</b> y escribe el número.</div>}
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Número</th><th>Origen</th><th>Emitido</th><th className="num">Monto</th><th className="num">Saldo</th></tr></thead>
              <tbody>
                {vouchers.data.map((v) => (
                  <tr key={v.codigo}>
                    <td className="mono bold">{v.codigo}</td><td>{v.origen}{v.nota ? <div className="xs muted">{v.nota}</div> : null}</td><td>{dia(v.fecha_emision)}</td>
                    <td className="num">{money(v.monto)}</td><td className="num bold">{v.estado === 'Activo' ? money(v.saldo) : <Badge>{v.estado}</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {porPagar.map((s) => (
        <div key={s.codigo} className="card mb-16">
          <div className="row between wrap">
            <div><div className="card-title" style={{ marginBottom: 2 }}>{{ Anticipo: 'Anticipo pendiente (50 %)', Saldo: 'Saldo pendiente (50 %)', Total: 'Pendiente de pago', Cargo: 'Cargo adicional por pagar' }[s.por_pagar.tipo]}</div><div className="small muted">{s.codigo} · {s.servicio}</div></div>
            <button className="btn btn-yellow" onClick={() => navigate(`/pagos/${s.codigo}`)}>Pagar {money(s.por_pagar.monto)}</button>
          </div>
        </div>
      ))}
      <div className="card">
        <div className="card-title">Historial de pagos</div>
        {pagos.error && <div className="alert alert-err">{pagos.error.message}</div>}
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Pago</th><th>Solicitud / plan</th><th>Concepto</th><th>Método</th><th>Referencia</th><th>Fecha</th><th className="num">Monto</th><th>Estado</th><th /></tr></thead>
            <tbody>
              {(pagos.data || []).map((p) => (
                <tr key={p.id_pago}>
                  <td className="bold">{p.codigo_pago}</td><td>{p.solicitud || `Plan ${p.plan}`}</td><td>{{ Total: 'Pago único', Anticipo: 'Anticipo 50 %', Saldo: 'Saldo 50 %', Cargo: 'Cargo adicional' }[p.tipo_pago]}</td><td>{p.metodo_pago}</td><td className="mono">{p.referencia || '—'}</td>
                  <td>{fechaHora(p.fecha_pago)}</td><td className="num">RD$ {num(p.monto)}</td>
                  <td><Badge>{p.estado}</Badge>{p.observacion && p.estado === 'Rechazado' && <div className="xs muted">{p.observacion}</div>}</td>
                  <td><button className="btn btn-outline btn-sm" onClick={() => navigate(`/pagos/recibo/${p.id_pago}`)}>Recibo</button></td>
                </tr>
              ))}
              {!pagos.data?.length && <tr><td colSpan={9} className="center muted">{pagos.cargando ? 'Cargando…' : 'Aún no tienes pagos.'}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </Page>
  )
}

const CONCEPTO_EFECTIVO = { Total: 'total', Anticipo: 'anticipo (50 %)', Saldo: 'saldo (50 %)', Cargo: 'cargo adicional' }

export function ReportarEfectivo({ codigo, tipo = 'Total', total, onClose, onListo }) {
  const [monto, setMonto] = useState(total ? num(total) : '')
  const [recibo, setRecibo] = useState('')
  const [foto, setFoto] = useState(null)
  const [error, setError] = useState('')
  const [enviando, setEnviando] = useState(false)
  const valor = Number(String(monto).replace(/,/g, ''))
  const ok = total === undefined || Math.abs(valor - total) < 0.005

  const enviar = async () => {
    setError('')
    if (!/^[A-Za-z0-9-]{3,60}$/.test(recibo)) return setError('Indique el número de recibo')
    setEnviando(true)
    try {
      const fd = new FormData()
      fd.append('codigo', codigo)
      fd.append('monto', String(valor))
      fd.append('recibo', recibo)
      if (foto) fd.append('foto', foto)
      await post('/pagos/efectivo', fd)
      onListo?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setEnviando(false)
    }
  }

  return (
    <Modal titulo={`💵 Cobrar ${CONCEPTO_EFECTIVO[tipo]} en efectivo · ${codigo}`} onClose={onClose}>
      <div className="form-grid">
        <Field label="Monto recibido (RD$)" hint={ok && total ? `Debe coincidir con el ${CONCEPTO_EFECTIVO[tipo]}: ${money(total)} ✓` : undefined} error={!ok ? `El monto no coincide (${money(total)})` : undefined}>
          <input className={`input ${ok ? 'ok' : 'err'}`} inputMode="decimal" value={monto} onChange={(e) => setMonto(decimal(e.target.value))} />
        </Field>
        <Field label="No. de recibo"><input className="input" value={recibo} onChange={(e) => setRecibo(referencia(e.target.value))} placeholder="REC-000482" /></Field>
        <Field label="Foto del recibo firmado (opcional)" className="full">
          <label className="input" style={{ cursor: 'pointer' }}>{foto ? `📎 ${foto.name}` : '📎 Elegir foto'}<input type="file" hidden accept="image/*,.pdf" onChange={(e) => setFoto(e.target.files[0] || null)} /></label>
        </Field>
      </div>
      <div className="alert alert-warn mt-12">El pago queda <b>En verificación</b> hasta que administración lo concilie con tu depósito.</div>
      {error && <div className="alert alert-err mt-12">{error}</div>}
      <div className="row end mt-16">
        <button className="btn btn-ghost" onClick={onClose}>Cancelar <span className="kbd">Esc</span></button>
        <button className="btn btn-primary" disabled={!ok || enviando} onClick={enviar}>{enviando ? 'Registrando…' : 'Registrar cobro'}</button>
      </div>
    </Modal>
  )
}

export function Cobros() {
  const cobros = useApi('/pagos/efectivo/mios')
  return (
    <Page crumb="Prestador · Cobros en efectivo" title="Cobros en efectivo">
      <div className="card">
        <div className="card-title">Cobros reportados</div>
        <div className="xs muted mb-12">Para cobrar en efectivo usa el botón “Cobrar … en efectivo” de la solicitud en Mi panel o en Asignaciones: el anticipo al llegar y el saldo cuando el cliente confirme la finalización.</div>
        {cobros.error && <div className="alert alert-err">{cobros.error.message}</div>}
        <table className="table">
          <thead><tr><th>Solicitud</th><th>Concepto</th><th>Cliente</th><th>Recibo</th><th>Fecha</th><th className="num">Monto</th><th>Estado</th></tr></thead>
          <tbody>
            {(cobros.data || []).map((r) => <tr key={r.id_pago}><td className="bold">{r.solicitud}</td><td>{{ Total: 'Total', Anticipo: 'Anticipo 50 %', Saldo: 'Saldo 50 %', Cargo: 'Cargo adicional' }[r.tipo_pago]}</td><td>{r.cliente}</td><td className="mono">{r.recibo}</td><td>{fechaHora(r.fecha_pago)}</td><td className="num">RD$ {num(r.monto)}</td><td><Badge>{r.estado}</Badge></td></tr>)}
            {!cobros.data?.length && <tr><td colSpan={7} className="center muted">{cobros.cargando ? 'Cargando…' : 'Aún no has reportado cobros.'}</td></tr>}
          </tbody>
        </table>
      </div>
    </Page>
  )
}

// PAG-P06 · Conciliación de pagos (Figura 45)
const FILTRO_PAGOS = { 'En verificación': 'En verificación', Confirmados: 'Confirmado', Rechazados: 'Rechazado', Reembolsados: 'Reembolsado', Todos: 'Todos' }
const CONCEPTO_PAGO = { Total: 'Pago único', Anticipo: 'Anticipo 50 %', Saldo: 'Saldo 50 %', Cargo: 'Cargo adicional' }
const ICONO_METODO = { Efectivo: '💵', Transferencia: '🏦', Tarjeta: '💳', PayPal: '🅿️' }

export function Conciliacion() {
  const navigate = useNavigate()
  const [f, setF] = useState('En verificación')
  const datos = useApi(`/admin/pagos?estado=${encodeURIComponent(FILTRO_PAGOS[f])}`)
  const [selId, setSelId] = useState(null)
  const [obs, setObs] = useState('')
  const [formaReembolso, setFormaReembolso] = useState('Dinero') // reembolso en dinero o como voucher
  const [error, setError] = useState('')
  const [aviso, setAviso] = useState(null)
  const [ocupado, setOcupado] = useState(false)

  const lista = datos.data?.pagos || []
  const k = datos.data?.kpis
  const sel = lista.find((p) => p.id_pago === selId) || lista[0] || null

  const verComprobante = async (p) => {
    const r = await fetch(`/api/archivos/${p.comprobante_url.split('/').pop()}`, { headers: { Authorization: `Bearer ${leerSesion()?.token}` } })
    if (!r.ok) return setError('No se pudo abrir el comprobante')
    window.open(URL.createObjectURL(await r.blob()), '_blank', 'noopener')
  }
  const decidir = async (decision) => {
    setError('')
    setAviso(null)
    if (decision === 'Rechazar' && !obs.trim()) return setError('Indique el motivo del rechazo')
    setOcupado(true)
    try {
      await post(`/admin/pagos/${sel.id_pago}/conciliar`, { decision, observacion: obs })
      setAviso({ tipo: 'ok', texto: decision === 'Confirmar'
        ? `${sel.codigo_pago} confirmado. Se notificó al cliente y se está emitiendo su factura e-CF.`
        : `${sel.codigo_pago} rechazado. Se notificó al cliente para que pague de nuevo.` })
      setObs('')
      setSelId(null)
      datos.recargar()
    } catch (e) {
      setError(e.message)
    } finally {
      setOcupado(false)
    }
  }
  const reembolsar = async () => {
    setError('')
    if (!obs.trim()) return setError('Indique el motivo del reembolso')
    const enDinero = Number(sel.monto) - Number(sel.monto_voucher || 0)
    if (!window.confirm(`¿Reembolsar ${sel.codigo_pago} por ${money(sel.monto)}? Se emitirá una nota de crédito.${formaReembolso === 'Voucher' && enDinero > 0 ? ` El cliente recibirá un voucher por ${money(enDinero)}.` : ''}`)) return
    setOcupado(true)
    try {
      const r = await post(`/admin/pagos/${sel.id_pago}/reembolsar`, { motivo: obs, forma: formaReembolso })
      const devolver = enDinero > 0 && !r.voucher ? ` Recuerde devolver ${money(enDinero)} por ${sel.metodo_pago}.` : ''
      setAviso({ tipo: 'ok', texto: `${sel.codigo_pago} reembolsado${r.nota_credito ? ` · nota de crédito ${r.nota_credito}` : ''}.${r.voucher ? ` Voucher ${r.voucher.codigo} por ${money(r.voucher.monto)} emitido al cliente.` : ''}${sel.monto_voucher ? ` ${money(sel.monto_voucher)} vuelven al voucher ${sel.voucher}.` : ''}${devolver}` })
      setObs('')
      datos.recargar()
    } catch (e) {
      setError(e.message)
    } finally {
      setOcupado(false)
    }
  }

  return (
    <Page crumb="Administración · Pagos" title="Conciliación de pagos">
      <div className="grid g-4 mb-16">
        <Kpi label="En verificación" value={k ? num0(k.en_verificacion) : '—'} foot={k ? money(k.monto_verificacion) : null} color="var(--purple)" />
        <Kpi label="Confirmados hoy" value={k ? num0(k.confirmados_hoy) : '—'} foot={k ? money(k.monto_hoy) : null} />
        <Kpi label="PayPal / Tarjeta (auto)" value={k ? `${Math.round(k.pct_en_linea || 0)}%` : '—'} foot="de los pagos confirmados del mes" />
        <Kpi label="Rechazados (mes)" value={k ? num0(k.rechazados_mes) : '—'} foot="el cliente debe pagar de nuevo" color="var(--red)" />
      </div>
      {aviso && <div className={`alert ${aviso.tipo === 'ok' ? 'alert-ok' : 'alert-err'} mb-16`}>{aviso.texto}</div>}
      <div className="split" style={{ gridTemplateColumns: 'minmax(0,1fr) 380px' }}>
        <div className="card">
          <div className="row between wrap mb-12">
            <Chips valor={f} onChange={(v) => { setF(v); setSelId(null); setError('') }} opciones={Object.keys(FILTRO_PAGOS).map((o) => (
              o === 'En verificación' ? { value: o, label: `En verificación${k ? ` (${k.en_verificacion})` : ''}` } : o))} />
            <button className="link-btn small" onClick={datos.recargar}>↻ Actualizar</button>
          </div>
          {datos.error && <div className="alert alert-err">{datos.error.message}</div>}
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Pago</th><th>Concepto</th><th>Cliente</th><th>Método</th><th>Referencia</th><th className="num">Monto</th><th>Fecha</th>{f !== 'En verificación' && <th>Estado</th>}</tr></thead>
              <tbody>
                {lista.map((p) => (
                  <tr key={p.id_pago} className={`clickable ${sel?.id_pago === p.id_pago ? 'selected' : ''}`} onClick={() => { setSelId(p.id_pago); setError(''); setObs('') }}>
                    <td className="bold">{p.codigo_pago}</td>
                    <td>{p.solicitud || 'Plan'}<div className="xs muted">{CONCEPTO_PAGO[p.tipo_pago] || p.tipo_pago}</div></td>
                    <td>{p.razon_social || p.cliente}</td>
                    <td>{ICONO_METODO[p.metodo_pago]} {p.metodo_pago}</td><td className="mono">{p.referencia || '—'}</td>
                    <td className="num">{money(p.monto)}</td><td>{fecha(p.fecha_pago)}</td>
                    {f !== 'En verificación' && <td><Badge>{p.estado}</Badge></td>}
                  </tr>
                ))}
                {!lista.length && <tr><td colSpan={8} className="muted center">{datos.cargando ? 'Cargando…' : f === 'En verificación' ? '✓ No hay pagos por conciliar.' : 'No hay pagos en este filtro.'}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        {sel ? (
          <div className="card">
            <div className="card-title">{sel.estado === 'En verificación' ? 'Verificar' : 'Pago'} {sel.codigo_pago} <Badge>{sel.estado}</Badge></div>
            <div className="card small" style={{ background: '#fafcfb', padding: 12 }}>
              <div className="bold" style={{ color: 'var(--blue)' }}>
                {sel.metodo_pago === 'Efectivo' ? 'Cobro en efectivo reportado por el prestador' : sel.metodo_pago === 'Transferencia' ? 'Transferencia bancaria' : `Pago con ${sel.metodo_pago}`}
              </div>
              <div className="kv mt-8 xs" style={{ gridTemplateColumns: '110px 1fr' }}>
                <div>Cliente</div><div>{sel.razon_social || sel.cliente}</div>
                <div>{sel.metodo_pago === 'Efectivo' ? 'No. de recibo' : 'Referencia'}</div><div className="mono">{sel.referencia || '—'}</div>
                <div>Fecha</div><div>{fechaHora(sel.fecha_pago)}</div>
                <div>Concepto</div><div>{sel.solicitud ? <button className="link-btn xs" onClick={() => navigate(`/seguimiento/${sel.solicitud}`)}>{sel.solicitud}</button> : 'Plan de suscripción'} · {CONCEPTO_PAGO[sel.tipo_pago] || sel.tipo_pago}</div>
                <div>Monto</div><div><b>{money(sel.monto)}</b>{sel.voucher && <div className="xs muted">Voucher {sel.voucher}: {money(sel.monto_voucher)} · por {sel.metodo_pago}: {money(sel.monto - sel.monto_voucher)}</div>}</div>
                {sel.confirmado_por?.trim() && <><div>Confirmado por</div><div>{sel.confirmado_por}</div></>}
                {sel.observacion && <><div>Observación</div><div>{sel.observacion}</div></>}
              </div>
              {sel.comprobante_url
                ? <button className="btn btn-outline btn-sm mt-8" onClick={() => verComprobante(sel)}>📎 Ver comprobante adjunto</button>
                : sel.estado === 'En verificación' && <div className="xs muted mt-8">Sin comprobante adjunto.</div>}
            </div>

            {sel.estado === 'En verificación' && (
              <>
                <div className="alert alert-info xs mt-12">
                  {sel.metodo_pago === 'Transferencia'
                    ? `Verifique en el estado de cuenta del banco que entró ${money(sel.monto)} con la referencia ${sel.referencia}.`
                    : `Verifique que el prestador depositó ${money(sel.monto)} del recibo ${sel.referencia}.`}
                  {' '}El monto ya fue calculado por el sistema para este cobro.
                </div>
                <Field label="Observación" className="mt-12" error={error}>
                  <input className="input" maxLength={200} placeholder="Opcional (obligatoria si rechaza)" value={obs} onChange={(e) => setObs(e.target.value)} />
                </Field>
                <div className="grid g-2 mt-12" style={{ gap: 8 }}>
                  <button className="btn btn-primary" disabled={ocupado} onClick={() => decidir('Confirmar')}>{ocupado ? 'Procesando…' : '✓ Confirmar pago'}</button>
                  <button className="btn btn-danger" disabled={ocupado} onClick={() => decidir('Rechazar')}>✕ Rechazar</button>
                </div>
                <div className="xs muted mt-8">Al confirmar, el pago queda Confirmado a su nombre, se avisa al cliente y se emite la factura e-CF.</div>
              </>
            )}
            {sel.estado === 'Confirmado' && (
              <>
                <Field label="Motivo del reembolso" className="mt-12" error={error}>
                  <input className="input" maxLength={200} placeholder="Ej.: servicio cancelado por el prestador" value={obs} onChange={(e) => setObs(e.target.value)} />
                </Field>
                {Number(sel.monto) > Number(sel.monto_voucher || 0) && (
                  <div className="mt-12">
                    <div className="label mb-8">¿Cómo se le devuelve al cliente?</div>
                    <Chips valor={formaReembolso} onChange={setFormaReembolso} opciones={[{ value: 'Dinero', label: `💸 Dinero (${sel.metodo_pago})` }, { value: 'Voucher', label: '🎟️ Voucher (saldo a favor)' }]} />
                  </div>
                )}
                <button className="btn btn-outline btn-block mt-12" disabled={ocupado} onClick={reembolsar}>↩ Reembolsar pago</button>
                <div className="xs muted mt-8">
                  Emite una nota de crédito. {formaReembolso === 'Voucher' ? 'El cliente recibe un voucher con el número para usarlo en su próximo servicio.' : 'La devolución del dinero se hace aparte.'}
                  {sel.voucher ? ` Lo pagado con el voucher ${sel.voucher} vuelve a ese voucher.` : ''}
                </div>
              </>
            )}
            {!['En verificación', 'Confirmado'].includes(sel.estado) && error && <div className="alert alert-err mt-12">{error}</div>}
          </div>
        ) : (
          <div className="card muted">{datos.cargando ? 'Cargando…' : 'Seleccione un pago de la lista.'}</div>
        )}
      </div>
    </Page>
  )
}

// Una sola captura por pago aunque el efecto se ejecute dos veces (React StrictMode) o se recargue la página
const capturas = new Map()
const capturarUnaVez = (id) => {
  if (!capturas.has(id)) capturas.set(id, post(`/pagos/${id}/paypal/capturar`))
  return capturas.get(id)
}

// PAG-P02 · Regreso desde PayPal: captura la orden aprobada y confirma el pago
export function PaypalRetorno() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { rol } = useSession()
  const prestador = rol === 'Empleado' // pago de su membresía
  const id = params.get('pago')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!id) return
    let vivo = true
    capturarUnaVez(id)
      .then(() => vivo && navigate(`${prestador ? '/prestador/recibo' : '/pagos/recibo'}/${id}`, { replace: true }))
      .catch((e) => vivo && setError(e.message))
    return () => { vivo = false }
  }, [id, navigate, prestador])

  return (
    <Page crumb="Pagos · PayPal" title="Confirmando pago">
      <div className="card center" style={{ maxWidth: 520, margin: '20px auto', padding: 30 }}>
        {!id ? <div className="alert alert-err">Falta el identificador del pago.</div> : error ? (
          <>
            <div style={{ fontSize: 40 }}>⚠️</div>
            <div className="alert alert-err mt-12">{error}</div>
            <button className="btn btn-outline mt-16" onClick={() => navigate(prestador ? '/prestador/membresia' : '/mis-solicitudes')}>{prestador ? 'Volver a membresía' : 'Volver a mis solicitudes'}</button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 40 }}>⏳</div>
            <div className="bold mt-8">Confirmando tu pago con PayPal…</div>
            <div className="small muted">No cierres esta ventana.</div>
          </>
        )}
      </div>
    </Page>
  )
}

// =====================================================================
// PAG-P08 · Modelo marketplace: cuenta del prestador (comisiones, ganancias y liquidaciones)
// =====================================================================
const COLOR_MOV = { 'Servicio realizado': 'green', Comisión: 'orange', 'Comisión extra': 'orange', 'Efectivo cobrado': 'blue', Reverso: 'gray', Liquidación: 'purple' }

/** Saldo con su lectura: a favor del prestador, en contra o al día. */
const textoSaldo = (saldo) => (saldo > 0 ? 'La plataforma te debe' : saldo < 0 ? 'Debes a la plataforma' : 'Cuenta al día')

function TablaMovimientos({ movimientos, onSolicitud }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Fecha</th><th>Concepto</th><th>Solicitud</th><th className="num">Monto</th></tr></thead>
        <tbody>
          {movimientos.map((m) => (
            <tr key={m.id_movimiento}>
              <td>{fecha(m.fecha)}</td>
              <td><Badge color={COLOR_MOV[m.tipo]}>{m.tipo}</Badge><div className="xs muted">{m.descripcion}</div></td>
              <td>{m.solicitud ? (onSolicitud ? <button className="link-btn" onClick={() => onSolicitud(m.solicitud)}>{m.solicitud}</button> : m.solicitud) : '—'}</td>
              <td className={`num bold ${Number(m.monto) < 0 ? 'red' : 'green'}`}>{Number(m.monto) < 0 ? '−' : '+'} {money(Math.abs(m.monto))}</td>
            </tr>
          ))}
          {!movimientos.length && <tr><td colSpan={4} className="center muted">Aún no hay movimientos.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

// Prestador · Mis ganancias
export function Ganancias() {
  const navigate = useNavigate()
  const c = useApi('/pagos/prestador/cuenta')
  const d = c.data
  return (
    <Page crumb="Prestador · Mis ganancias" title="Mis ganancias">
      {c.error && <div className="alert alert-err mb-16">{c.error.message}</div>}
      <div className="grid g-4 mb-16">
        <Kpi label={d ? textoSaldo(d.saldo) : 'Saldo'} value={d ? money(Math.abs(d.saldo)) : '—'} color={d?.saldo < 0 ? 'var(--red)' : undefined} foot="Se liquida con administración" />
        <Kpi label="Ganado (mes)" value={d ? money(d.mes.ganado) : '—'} foot="Valor de los servicios sin ITBIS" />
        <Kpi label="Comisiones (mes)" value={d ? money(d.mes.comisiones) : '—'} color="var(--orange)" />
        <Kpi label="Efectivo en mano (mes)" value={d ? money(d.mes.efectivo) : '—'} foot="Cobrado por ti al cliente" />
      </div>
      {d && (
        <div className="card mb-16 small">
          <div className="card-title">Cómo se calcula</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>Al <b>aceptar</b> un servicio se cobra una comisión de <b>{d.condiciones.comision_pct} %</b> de su valor sin ITBIS (mínimo {money(d.condiciones.comision_min)}). Si la solicitud se cancela, se devuelve.</li>
            <li>Los materiales y los cargos adicionales pagan el mismo {d.condiciones.comision_pct} % cuando se cobran.</li>
            <li>Ganas el valor del servicio a medida que el cliente paga: 50 % con el anticipo y el resto (más materiales) con el saldo.</li>
            <li>Lo que cobras <b>en efectivo</b> ya está en tus manos: se descuenta de tu saldo.</li>
          </ul>
          <div className="mt-8">
            {d.membresia
              ? <>Membresía <b>{d.membresia.plan}</b> vigente hasta {dia(d.membresia.vence)}{d.membresia.prioridad ? ' · prioridad en asignación' : ''}{d.membresia.destacado ? ' · destacado en el catálogo' : ''}.</>
              : <>Sin membresía. <button className="link-btn" onClick={() => navigate('/prestador/membresia')}>Ver planes</button> para bajar la comisión del {d.condiciones.comision_general_pct} % y recibir más trabajos.</>}
          </div>
        </div>
      )}
      <div className="card">
        <div className="card-title">Estado de cuenta</div>
        {d ? <TablaMovimientos movimientos={d.movimientos} /> : <div className="muted">{c.cargando ? 'Cargando…' : ''}</div>}
      </div>
    </Page>
  )
}

/** Liquidación de la cuenta: pagar al prestador su saldo a favor o cobrarle lo que debe. */
function Liquidar({ cuenta, onClose, onListo }) {
  const debe = cuenta.saldo < 0
  const [f, setF] = useState({ sentido: debe ? 'Cobro al prestador' : 'Pago al prestador', monto: String(Math.abs(cuenta.saldo).toFixed(2)), metodo: 'Transferencia', referencia: '', observacion: '' })
  const [error, setError] = useState(null)
  const [enviando, setEnviando] = useState(false)
  const enviar = async () => {
    setError(null)
    setEnviando(true)
    try { onListo(await post(`/admin/pagos/prestadores/${cuenta.id_empleado}/liquidar`, f)) } catch (e) { setError(e) } finally { setEnviando(false) }
  }
  return (
    <Modal titulo={`Liquidar · ${cuenta.prestador}`} onClose={onClose}>
      <div className="small mb-12">{textoSaldo(cuenta.saldo).replace('te debe', 'le debe').replace('Debes', 'Debe')}: <b>{money(Math.abs(cuenta.saldo))}</b></div>
      <Chips valor={f.sentido} onChange={(sentido) => setF({ ...f, sentido })} opciones={['Pago al prestador', 'Cobro al prestador']} />
      <div className="form-grid mt-12">
        <Field label="Monto (RD$)" req error={error?.detalles?.monto}><input className="input" inputMode="decimal" value={f.monto} onChange={(e) => setF({ ...f, monto: decimal(e.target.value) })} /></Field>
        <Field label="Método" req>
          <select className="input" value={f.metodo} onChange={(e) => setF({ ...f, metodo: e.target.value })}>{['Transferencia', 'Efectivo', 'PayPal'].map((m) => <option key={m}>{m}</option>)}</select>
        </Field>
      </div>
      <Field label="Referencia" className="mt-8"><input className="input" maxLength={60} value={f.referencia} onChange={(e) => setF({ ...f, referencia: referencia(e.target.value) })} /></Field>
      <Field label="Observación" className="mt-8"><input className="input" maxLength={200} value={f.observacion} onChange={(e) => setF({ ...f, observacion: e.target.value })} /></Field>
      {error && !error.detalles && <div className="alert alert-err mt-12">{error.message}</div>}
      <div className="row end mt-16">
        <button className="btn btn-ghost" onClick={onClose}>Cancelar <span className="kbd">Esc</span></button>
        <button className="btn btn-primary" disabled={enviando || !(Number(f.monto) > 0)} onClick={enviar}>{enviando ? 'Registrando…' : `Registrar ${f.sentido.toLowerCase()}`}</button>
      </div>
    </Modal>
  )
}

/** Parámetros de cobro de la plataforma (comisión al prestador y tarifa al cliente). */
function AjustesCobro() {
  const a = useApi('/admin/pagos/ajustes-cobro')
  const [f, setF] = useState(null)
  const [aviso, setAviso] = useState(null)
  const v = f || a.data
  const guardar = async () => {
    setAviso(null)
    try { await put('/admin/pagos/ajustes-cobro', v); setF(null); a.recargar(); setAviso({ ok: true, texto: 'Parámetros guardados. Aplican a las solicitudes y aceptaciones nuevas.' }) } catch (e) { setAviso({ ok: false, texto: e.message }) }
  }
  const campo = (k, label, hint) => (
    <Field label={label} hint={hint}><input className="input" inputMode="decimal" value={v?.[k] ?? ''} onChange={(e) => setF({ ...v, [k]: decimal(e.target.value) })} /></Field>
  )
  return (
    <div className="card">
      <div className="card-title">Parámetros de cobro</div>
      <div className="form-grid">
        {campo('comision_pct', 'Comisión al prestador (%)', 'Sobre el valor del servicio sin ITBIS, al aceptar')}
        {campo('comision_min', 'Comisión mínima (RD$)', 'Por servicio aceptado')}
        {campo('tarifa_cliente_pct', 'Tarifa al cliente (%)', 'Línea propia en la factura, con ITBIS')}
        {campo('tarifa_cliente_min', 'Tarifa mínima al cliente (RD$)', 'Por servicio')}
      </div>
      <div className="xs muted mt-8">Una membresía de prestador puede fijar su propia comisión (Planes y suscripciones).</div>
      {aviso && <div className={`alert ${aviso.ok ? 'alert-ok' : 'alert-err'} mt-12`}>{aviso.texto}</div>}
      <div className="row end mt-12"><button className="btn btn-primary" disabled={!f} onClick={guardar}>Guardar</button></div>
    </div>
  )
}

// Administración · Cuentas de prestadores y liquidaciones
export function CuentasPrestadores() {
  const navigate = useNavigate()
  const lista = useApi('/admin/pagos/prestadores')
  const [id, setId] = useState(null)
  const det = useApi(id ? `/admin/pagos/prestadores/${id}` : null)
  const [liquidar, setLiquidar] = useState(null)
  const [aviso, setAviso] = useState(null)
  const filas = lista.data || []
  const porPagar = filas.filter((x) => x.saldo > 0).reduce((s, x) => s + Number(x.saldo), 0)
  const porCobrar = filas.filter((x) => x.saldo < 0).reduce((s, x) => s - Number(x.saldo), 0)
  const comisiones = filas.reduce((s, x) => s + Number(x.comisiones_mes), 0)
  return (
    <Page crumb="Administración · Cuentas de prestadores" title="Cuentas de prestadores">
      <div className="grid g-3 mb-16">
        <Kpi label="Por pagar a prestadores" value={money(porPagar)} foot="Saldos a su favor" />
        <Kpi label="Por cobrar a prestadores" value={money(porCobrar)} color="var(--orange)" foot="Comisiones del efectivo cobrado" />
        <Kpi label="Comisiones del mes" value={money(comisiones)} />
      </div>
      {aviso && <div className="alert alert-ok mb-16">{aviso}</div>}
      <div className="grid g-2" style={{ alignItems: 'flex-start' }}>
        <div className="card">
          <div className="card-title">Prestadores</div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Prestador</th><th className="num">Saldo</th><th className="num">Comisiones (mes)</th><th /></tr></thead>
              <tbody>
                {filas.map((x) => (
                  <tr key={x.id_empleado} className={id === x.id_empleado ? 'selected' : ''} style={{ cursor: 'pointer' }} onClick={() => setId(x.id_empleado)}>
                    <td className="semibold">{x.prestador}<div className="xs muted">{x.especialidad}</div></td>
                    <td className={`num bold ${x.saldo < 0 ? 'red' : x.saldo > 0 ? 'green' : ''}`}>{money(Math.abs(x.saldo))}<div className="xs muted">{x.saldo > 0 ? 'a su favor' : x.saldo < 0 ? 'debe' : 'al día'}</div></td>
                    <td className="num">{money(x.comisiones_mes)}</td>
                    <td>{Number(x.saldo) !== 0 && <button className="btn btn-outline btn-sm" onClick={(e) => { e.stopPropagation(); setLiquidar(x) }}>Liquidar</button>}</td>
                  </tr>
                ))}
                {!filas.length && <tr><td colSpan={4} className="center muted">{lista.cargando ? 'Cargando…' : 'No hay prestadores aprobados.'}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <div className="col" style={{ gap: 16 }}>
          {id ? (
            <div className="card">
              <div className="card-title">{det.data?.prestador || 'Estado de cuenta'}</div>
              {det.data && (
                <div className="small mb-12">
                  {textoSaldo(det.data.saldo).replace('te debe', 'le debe').replace('Debes', 'Debe')}: <b>{money(Math.abs(det.data.saldo))}</b> · comisión {det.data.condiciones.comision_pct} %
                  {det.data.membresia ? ` · membresía ${det.data.membresia.plan}` : ' · sin membresía'}
                </div>
              )}
              {det.data ? <TablaMovimientos movimientos={det.data.movimientos} onSolicitud={(c) => navigate(`/seguimiento/${c}`)} /> : <div className="muted">Cargando…</div>}
            </div>
          ) : <div className="card muted">Seleccione un prestador para ver su estado de cuenta.</div>}
          <AjustesCobro />
        </div>
      </div>
      {liquidar && (
        <Liquidar cuenta={liquidar} onClose={() => setLiquidar(null)}
          onListo={(r) => { setAviso(`Liquidación registrada. Nuevo saldo de ${liquidar.prestador}: ${money(r.saldo)}.`); setLiquidar(null); lista.recargar(); det.recargar?.() }} />
      )}
    </Page>
  )
}
