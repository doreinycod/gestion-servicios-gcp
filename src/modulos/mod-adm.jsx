// MOD-ADM · Administración
// ADM-P01 Acceso y registro · Mi perfil · ADM-P02 Dashboard · ADM-P03 Aprobación de prestadores · ADM-P04 Usuarios y roles · ADM-P05 Reportes · Configuración
import { useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useSession, CUENTAS_DEMO, INICIO_POR_ROL } from '../components/session'
import { get, leerSesion, patch, post } from '../lib/api'
import { useApi } from '../lib/useApi'
import { Brand, Page } from '../components/Layout'
import { emailValido, cedulaValida, rncValido, telefonoValido, contrasenaValida, fortaleza } from '../lib/fiscal'
import { Field, Avatar, Badge, Chips, Kpi, PasswordInput } from '../components/ui'
import { usuarios, permisos, reporteIngresos } from '../data/mock'
import { num, num0, money0, hace, formatoCedula } from '../lib/format'
import { letras, textoSinNumeros, cedula, rncCedula, telefono, nombreValido, soloLetras, soloTextoSinNumeros, soloEntero, soloDecimal, soloTelefono, soloRncCedula } from '../lib/filtros'

// ADM-P01 · Pantalla de inicio de sesión (Figura 30)
export function Login() {
  const { iniciar } = useSession()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [pass, setPass] = useState('')
  const [error, setError] = useState('')
  const [enviando, setEnviando] = useState(false)

  // Valida contra la tabla usuarios (bcrypt, bloqueo tras 3 intentos) y carga v_usuarioActivo / v_rolActivo
  const acceder = async (correo, clave) => {
    setError('')
    if (!emailValido(correo)) return setError('Formato de correo inválido.')
    if (clave.length < 8) return setError('La contraseña debe tener mínimo 8 caracteres.')
    setEnviando(true)
    try {
      const r = await post('/auth/login', { email: correo, contrasena: clave })
      iniciar(r)
      navigate(INICIO_POR_ROL[r.usuario.rol])
    } catch (e2) {
      setError(e2.message)
    } finally {
      setEnviando(false)
    }
  }
  const entrar = (e) => { e.preventDefault(); acceder(email.trim().toLowerCase(), pass) }
  const demo = (rol) => { setEmail(CUENTAS_DEMO[rol]); setPass('Demo1234'); acceder(CUENTAS_DEMO[rol], 'Demo1234') }

  return (
    <div className="auth">
      <section className="auth-left">
        <Brand />
        <div style={{ margin: 'auto 0' }}>
          <h1>Técnicos, profesionales y servicios del hogar en un solo lugar.</h1>
          <p className="mt-16" style={{ color: '#c7dccf', maxWidth: 440, fontSize: 13.5 }}>
            Solicita en línea las 24 horas, da seguimiento en tiempo real, paga con PayPal, tarjeta, transferencia o efectivo y recibe tu factura electrónica (e-CF) al instante.
          </p>
        </div>
        <div className="row small" style={{ gap: 22, color: '#c7dccf' }}>
          <span>🔧 Técnicos</span><span>💼 Profesionales</span><span>🏠 Hogar</span>
        </div>
      </section>

      <section className="auth-right">
        <form className="auth-box" onSubmit={entrar}>
          <h2 style={{ fontSize: 22 }}>Iniciar sesión</h2>
          <p className="muted small mb-16">Accede como cliente, prestador o administrador.</p>

          <div className="col">
            <div className="field">
              <label className="label">Correo electrónico</label>
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
            </div>
            <div className="field">
              <label className="label">Contraseña</label>
              <PasswordInput value={pass} onChange={(e) => setPass(e.target.value)} placeholder="••••••••••" autoComplete="current-password" />
              <span className="hint">Mínimo 8 caracteres. Tras 3 intentos fallidos la cuenta se bloquea 15 minutos.</span>
            </div>
            {error && <div className="alert alert-err">{error}</div>}
            <div className="row between">
              <label className="check"><input type="checkbox" defaultChecked /> Recordarme</label>
              <Link to={`/olvide${email ? `?email=${encodeURIComponent(email.trim().toLowerCase())}` : ''}`} className="small semibold">¿Olvidaste tu contraseña?</Link>
            </div>
            <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={enviando}>{enviando ? 'Verificando…' : 'Iniciar sesión'}</button>
          </div>

          <div className="or">¿Nuevo en la plataforma?</div>
          <div className="grid g-2" style={{ gap: 10 }}>
            <Link to="/registro" className="btn btn-outline">Crear cuenta de cliente</Link>
            <Link to="/prestadores/registro" className="btn btn-soft">Quiero ser prestador</Link>
          </div>


          <div className="mt-16 small muted center">
            Acceso de demostración:{' '}
            <button type="button" className="link-btn" onClick={() => demo('Cliente')}>Cliente</button> ·{' '}
            <button type="button" className="link-btn" onClick={() => demo('Empleado')}>Prestador</button> ·{' '}
            <button type="button" className="link-btn" onClick={() => demo('Administrador')}>Administrador</button>
          </div>
        </form>
      </section>
    </div>
  )
}

/** Columna de marca de las pantallas de acceso. */
function MarcaAcceso({ titulo, texto }) {
  return (
    <section className="auth-left">
      <Brand />
      <div style={{ margin: 'auto 0' }}>
        <h1>{titulo}</h1>
        <p className="mt-16" style={{ color: '#c7dccf', maxWidth: 440, fontSize: 13.5 }}>{texto}</p>
      </div>
      <div className="row small" style={{ gap: 22, color: '#c7dccf' }}><span>🔧 Técnicos</span><span>💼 Profesionales</span><span>🏠 Hogar</span></div>
    </section>
  )
}

// ADM-P01 · ¿Olvidaste tu contraseña?: pide el enlace de restablecimiento por correo
export function OlvideContrasena() {
  const [params] = useSearchParams()
  const [email, setEmail] = useState(params.get('email') || '')
  const [error, setError] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [listo, setListo] = useState(null) // { mensaje, enlace_dev }
  const pedir = async (e) => {
    e.preventDefault()
    setError('')
    const correo = email.trim().toLowerCase()
    if (!emailValido(correo)) return setError('Formato de correo inválido.')
    setEnviando(true)
    try { setListo(await post('/auth/olvide', { email: correo })) } catch (e2) { setError(e2.message) } finally { setEnviando(false) }
  }
  return (
    <div className="auth">
      <MarcaAcceso titulo="¿Olvidaste tu contraseña? Te ayudamos a recuperarla." texto="Te enviamos a tu correo un enlace seguro para crear una contraseña nueva. Vence en 30 minutos y solo se puede usar una vez." />
      <section className="auth-right">
        <form className="auth-box" onSubmit={pedir}>
          <h2 style={{ fontSize: 22 }}>Recuperar contraseña</h2>
          {listo ? (
            <>
              <div className="alert alert-ok mt-12">📧 {listo.mensaje}</div>
              <p className="small muted mt-12">Revisa también la carpeta de spam. Si no llega en unos minutos, puedes pedirlo de nuevo.</p>
              {listo.enlace_dev && (
                <div className="alert alert-warn small mt-12">
                  <b>Modo desarrollo:</b> el envío de correos (SMTP) no está configurado, así que el correo no salió. Usa este enlace para probar:
                  <div className="mt-8"><a href={listo.enlace_dev} style={{ wordBreak: 'break-all' }}>{listo.enlace_dev}</a></div>
                </div>
              )}
              <div className="row mt-16" style={{ gap: 10 }}>
                <button type="button" className="btn btn-outline" onClick={() => setListo(null)}>Enviar de nuevo</button>
                <Link to="/login" className="btn btn-primary">Volver a iniciar sesión</Link>
              </div>
            </>
          ) : (
            <>
              <p className="muted small mb-16">Escribe el correo con el que te registraste.</p>
              <div className="col">
                <Field label="Correo electrónico"><input className="input" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></Field>
                {error && <div className="alert alert-err">{error}</div>}
                <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={enviando}>{enviando ? 'Enviando…' : 'Enviar enlace'}</button>
                <Link to="/login" className="small semibold center">← Volver a iniciar sesión</Link>
              </div>
            </>
          )}
        </form>
      </section>
    </div>
  )
}

// ADM-P01 · Restablecer contraseña desde el enlace del correo
export function RestablecerContrasena() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const token = params.get('token') || ''
  const v = useApi(token ? `/auth/restablecer/${encodeURIComponent(token)}` : null)
  const cuenta = !token ? { error: 'El enlace no es válido. Pide uno nuevo.' } : v.error ? { error: v.error.message } : v.data // { nombre, email } | { error }
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [error, setError] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [listo, setListo] = useState(false)

  const guardar = async (e) => {
    e.preventDefault()
    setError('')
    if (!contrasenaValida(pass)) return setError('La contraseña debe tener mínimo 8 caracteres, una mayúscula y un número.')
    if (pass !== pass2) return setError('Las contraseñas no coinciden.')
    setEnviando(true)
    try { await post('/auth/restablecer', { token, contrasena: pass }); setListo(true) } catch (e2) { setError(e2.message) } finally { setEnviando(false) }
  }
  return (
    <div className="auth">
      <MarcaAcceso titulo="Crea una contraseña nueva." texto="Usa al menos 8 caracteres, una mayúscula y un número. Al guardarla, tu cuenta queda desbloqueada y el enlace deja de funcionar." />
      <section className="auth-right">
        <form className="auth-box" onSubmit={guardar}>
          <h2 style={{ fontSize: 22 }}>Nueva contraseña</h2>
          {!cuenta && <p className="muted small">Verificando el enlace…</p>}
          {cuenta?.error && (
            <>
              <div className="alert alert-err mt-12">{cuenta.error}</div>
              <Link to="/olvide" className="btn btn-primary mt-16">Pedir un enlace nuevo</Link>
            </>
          )}
          {listo && (
            <>
              <div className="alert alert-ok mt-12">✅ Listo, {cuenta.nombre}. Tu contraseña se cambió; ya puedes iniciar sesión.</div>
              <button type="button" className="btn btn-primary btn-lg btn-block mt-16" onClick={() => navigate('/login')}>Iniciar sesión</button>
            </>
          )}
          {cuenta && !cuenta.error && !listo && (
            <>
              <p className="muted small mb-16">Cuenta: <b>{cuenta.email}</b></p>
              <div className="col">
                <Field label="Nueva contraseña" hint={pass ? `Seguridad: ${fortaleza(pass)}` : 'Mínimo 8 caracteres, una mayúscula y un número.'}>
                  <PasswordInput value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" autoFocus />
                </Field>
                <Field label="Confirmar contraseña" error={pass2 && pass !== pass2 ? 'Las contraseñas no coinciden' : null}>
                  <PasswordInput value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" />
                </Field>
                {error && <div className="alert alert-err">{error}</div>}
                <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={enviando}>{enviando ? 'Guardando…' : 'Guardar contraseña'}</button>
              </div>
            </>
          )}
        </form>
      </section>
    </div>
  )
}

// ADM-P01 · Registro de cliente (Figura 31)
export function Registro() {
  const navigate = useNavigate()
  const { iniciar } = useSession()
  const [f, setF] = useState({
    tipo: 'Persona física', nombre: '', apellido: '', doc: '', razon: '',
    telefono: '', email: '', ciudad: 'Santiago de los Caballeros', direccion: '', pass: '', pass2: '', terminos: false,
  })
  const [tocado, setTocado] = useState({})
  const [errorServidor, setErrorServidor] = useState('')
  const [enviando, setEnviando] = useState(false)
  const set = (k, filtro) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : filtro ? filtro(e.target.value) : e.target.value })
  const blur = (k) => () => setTocado({ ...tocado, [k]: true })
  const empresa = f.tipo === 'Empresa'
  // Consulta del RNC en la DGII: al completar 9 dígitos válidos se trae la razón social registrada
  const [dgii, setDgii] = useState(null) // { estado: 'consultando' | 'ok' | 'no' | 'sin-verificar', nombre, motivo }
  const ultimaConsulta = useRef('')
  const cambiarRnc = async (e) => {
    const valor = rncCedula(e.target.value)
    const digitos = valor.replace(/\D/g, '')
    setF((x) => ({ ...x, doc: valor }))
    if (digitos.length !== 9 || !rncValido(digitos)) { ultimaConsulta.current = ''; setDgii(null); return }
    if (ultimaConsulta.current === digitos) return
    ultimaConsulta.current = digitos
    setDgii({ estado: 'consultando' })
    try {
      const r = await get(`/contribuyentes/${digitos}`)
      if (ultimaConsulta.current !== digitos) return // el usuario ya cambió el número
      if (!r.valido) setDgii({ estado: 'no', motivo: r.motivo })
      else if (r.verificado && r.nombre) {
        setDgii({ estado: 'ok', nombre: r.nombre, situacion: r.estado })
        setF((x) => ({ ...x, razon: r.nombre }))
      } else setDgii({ estado: 'sin-verificar' })
    } catch (err) {
      if (ultimaConsulta.current === digitos) setDgii({ estado: 'sin-verificar', motivo: err.message })
    }
  }

  const errores = {
    nombre: !nombreValido(f.nombre) && 'Indique el nombre (solo letras)',
    apellido: f.apellido.trim() && !nombreValido(f.apellido) && 'El apellido solo admite letras',
    doc: empresa ? (!rncValido(f.doc) ? 'RNC inválido' : dgii?.estado === 'no' && (dgii.motivo || 'No está inscrito en la DGII')) : (f.doc && !cedulaValida(f.doc) && 'Cédula inválida'),
    razon: empresa && !f.razon.trim() && 'Indique la razón social',
    email: !emailValido(f.email) && 'Formato de correo inválido.',
    telefono: !telefonoValido(f.telefono) && 'Teléfono inválido',
    direccion: f.direccion.trim().length < 5 && 'Indique la dirección',
    pass: !contrasenaValida(f.pass) && 'La contraseña no cumple los requisitos',
    pass2: f.pass !== f.pass2 && 'Las contraseñas no coinciden',
  }
  const err = (k) => (tocado[k] ? errores[k] : null)
  const docOk = f.doc && !errores.doc

  // Crea usuarios + clientes en una transacción (POST /auth/registro)
  const crear = async (e) => {
    e.preventDefault()
    setErrorServidor('')
    setTocado(Object.fromEntries(Object.keys(errores).map((k) => [k, true])))
    if (Object.values(errores).some(Boolean)) return
    if (!f.terminos) return setErrorServidor('Debe aceptar los términos de uso y la política de privacidad.')
    setEnviando(true)
    try {
      const r = await post('/auth/registro', {
        tipo_cliente: f.tipo, nombre: f.nombre, apellido: f.apellido, rnc_cedula: f.doc, razon_social: f.razon,
        telefono: f.telefono, email: f.email.trim().toLowerCase(), ciudad: f.ciudad, direccion: f.direccion, contrasena: f.pass,
      })
      iniciar(r)
      navigate('/catalogo')
    } catch (e2) {
      setErrorServidor(e2.message)
    } finally {
      setEnviando(false)
    }
  }

  return (
    <div className="center-page">
      <form className="card" style={{ maxWidth: 760, width: '100%', alignSelf: 'flex-start', padding: 28 }} onSubmit={crear}
        onKeyDown={(e) => e.key === 'Escape' && navigate('/login')}>
        <h2 style={{ fontSize: 19 }}>Crear cuenta de cliente</h2>
        <p className="muted small mb-16">Tus datos fiscales determinan el tipo de comprobante (e32 Consumo o e31 Crédito Fiscal).</p>

        <div className="label mb-8">Tipo de cliente</div>
        <div className="grid g-2 mb-16" style={{ gap: 12 }}>
          {[['Persona física', 'Factura de Consumo (e32)'], ['Empresa', 'Factura de Crédito Fiscal (e31) – requiere RNC']].map(([t, d]) => (
            <label key={t} className={`option-card ${f.tipo === t ? 'selected' : ''}`}>
              <input type="radio" name="tipo" checked={f.tipo === t} onChange={() => { setF({ ...f, tipo: t, doc: '', razon: '' }); setDgii(null); ultimaConsulta.current = '' }} />
              <div><div className="semibold">{t}</div><div className="xs muted">{d}</div></div>
            </label>
          ))}
        </div>

        <div className="form-grid">
          <Field label={empresa ? 'Nombre del contacto' : 'Nombre(s)'} error={err('nombre')}>
            <input className="input" autoComplete="given-name" value={f.nombre} onChange={set('nombre', letras)} onBlur={blur('nombre')} />
          </Field>
          <Field label="Apellido(s)" error={err('apellido')}>
            <input className="input" autoComplete="family-name" value={f.apellido} onChange={set('apellido', letras)} onBlur={blur('apellido')} />
          </Field>
          <Field label={empresa ? 'RNC' : 'Cédula'} error={err('doc') || (empresa && dgii?.estado === 'no' ? dgii.motivo || 'No está inscrito en la DGII' : null)}
            hint={!empresa ? 'Se valida dígito verificador (11 dígitos).'
              : dgii?.estado === 'consultando' ? 'Consultando en la DGII…'
                : dgii?.estado === 'ok' ? `✓ ${dgii.nombre} · ${dgii.situacion} en la DGII`
                  : dgii?.estado === 'sin-verificar' ? '✓ Dígito verificador válido (no se pudo consultar la DGII)'
                    : 'Escriba los 9 dígitos: se consulta la razón social en la DGII.'}>
            <input className={`input ${docOk ? 'ok' : err('doc') || dgii?.estado === 'no' ? 'err' : ''}`} inputMode="numeric" value={f.doc}
              placeholder={empresa ? '1-32-45678-5' : '000-0000000-0'} onChange={empresa ? cambiarRnc : set('doc', cedula)} onBlur={blur('doc')} />
          </Field>
          {empresa ? (
            <Field label="Razón social" error={err('razon')} hint={dgii?.estado === 'ok' ? 'Nombre registrado en la DGII' : dgii?.estado === 'consultando' ? 'Buscando…' : undefined}>
              <input className={`input ${dgii?.estado === 'ok' ? 'ok' : ''}`} value={f.razon} readOnly={dgii?.estado === 'ok'} onChange={set('razon')} onBlur={blur('razon')} />
            </Field>
          ) : (
            <Field label="Teléfono / WhatsApp" error={err('telefono')}>
              <input className="input" inputMode="tel" placeholder="809-555-0000" value={f.telefono} onChange={set('telefono', telefono)} onBlur={blur('telefono')} />
            </Field>
          )}
          <Field label="Correo electrónico" error={err('email')}>
            <input className={`input ${err('email') ? 'err' : ''}`} value={f.email} onChange={set('email')} onBlur={blur('email')} />
          </Field>
          <Field label="Ciudad">
            <input className="input" value={f.ciudad} onChange={set('ciudad', textoSinNumeros)} />
          </Field>
          {empresa && (
            <Field label="Teléfono / WhatsApp" error={err('telefono')} className="full">
              <input className="input" inputMode="tel" placeholder="809-555-0000" value={f.telefono} onChange={set('telefono', telefono)} onBlur={blur('telefono')} />
            </Field>
          )}
          <Field label="Dirección principal" className="full" error={err('direccion')}>
            <input className="input" value={f.direccion} onChange={set('direccion')} onBlur={blur('direccion')} />
          </Field>
          <Field label="Contraseña" error={err('pass')} hint={`Fortaleza: ${fortaleza(f.pass)} · 8+ caracteres, mayúscula y número.`}>
            <PasswordInput value={f.pass} onChange={set('pass')} onBlur={blur('pass')} autoComplete="new-password" />
          </Field>
          <Field label="Confirmar contraseña" error={err('pass2')}>
            <PasswordInput value={f.pass2} onChange={set('pass2')} onBlur={blur('pass2')} autoComplete="new-password" />
          </Field>
        </div>

        <label className="check mt-16"><input type="checkbox" checked={f.terminos} onChange={set('terminos')} /> Acepto los términos de uso y la política de privacidad.</label>
        {errorServidor && <div className="alert alert-err mt-12">{errorServidor}</div>}

        <div className="row end mt-20">
          <button type="button" className="btn btn-ghost" onClick={() => navigate('/login')}>Cancelar <span className="kbd">Esc</span></button>
          <button type="submit" className="btn btn-primary" disabled={enviando}>{enviando ? 'Creando…' : 'Crear cuenta'}</button>
        </div>
      </form>
    </div>
  )
}

// Mi perfil del cliente: datos personales, fiscales y contraseña
export function MiPerfil() {
  return (
    <Page crumb="Inicio · Mi perfil" title="Mi perfil">
      <div className="split">
        <div className="card">
          <div className="card-title">Datos personales y fiscales</div>
          <div className="form-grid">
            <Field label="Nombre(s)"><input className="input" defaultValue="María Altagracia" onInput={soloLetras} /></Field>
            <Field label="Apellido(s)"><input className="input" defaultValue="Rodríguez Peña" onInput={soloLetras} /></Field>
            <Field label="Tipo de cliente"><select className="select" defaultValue="Persona física"><option>Persona física</option><option>Empresa</option></select></Field>
            <Field label="Cédula / RNC" hint="Determina el comprobante: e32 Consumo o e31 Crédito Fiscal."><input className="input ok" inputMode="numeric" defaultValue="402-1234567-8" onInput={soloRncCedula} /></Field>
            <Field label="Correo electrónico"><input className="input" defaultValue="maria.rodriguez@gmail.com" /></Field>
            <Field label="Teléfono / WhatsApp"><input className="input" inputMode="tel" defaultValue="809-555-0142" onInput={soloTelefono} /></Field>
            <Field label="Dirección principal" className="full"><input className="input" defaultValue="C/ José Amado Soler #45, Apto 3B, Piantini" /></Field>
            <Field label="Ciudad"><input className="input" defaultValue="Santiago de los Caballeros" onInput={soloTextoSinNumeros} /></Field>
          </div>
          <div className="row end mt-16"><button className="btn btn-primary">Guardar cambios</button></div>
        </div>
        <div className="col" style={{ gap: 16 }}>
          <div className="card center">
            <div style={{ display: 'grid', placeItems: 'center' }}><Avatar ini="MR" size="lg" /></div>
            <div className="bold mt-8">María Rodríguez</div>
            <div className="small muted">Cliente desde 03/2025</div>
            <div className="mt-8"><Badge>Activo</Badge> <Badge color="blue">Plan Hogar+</Badge></div>
          </div>
          <div className="card col">
            <div className="card-title" style={{ marginBottom: 0 }}>Cambiar contraseña</div>
            <Field label="Contraseña actual"><PasswordInput autoComplete="current-password" /></Field>
            <Field label="Nueva contraseña" hint="Mínimo 8 caracteres, una mayúscula y un número."><PasswordInput autoComplete="new-password" /></Field>
            <button className="btn btn-outline">Actualizar contraseña</button>
          </div>
        </div>
      </div>
    </Page>
  )
}

// ADM-P02 · Dashboard general (Figura 49)
const PERIODOS = { Hoy: 'hoy', '7 días': '7d', 'Este mes': 'mes', Año: 'anio' }
const TEXTO_PERIODO = { Hoy: 'de hoy', '7 días': 'de los últimos 7 días', 'Este mes': 'del mes', Año: 'del año' }
const VS_PERIODO = { Hoy: 'vs. ayer', '7 días': 'vs. 7 días anteriores', 'Este mes': 'vs. mes anterior', Año: 'vs. año anterior' }
const COLOR_ESTADO = { Pendiente: '#f0a63a', 'En proceso': '#3b82f6', Completado: '#1b5e3a', Cancelado: '#d63b3b' }
const MES_CORTO = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']

/** Variación porcentual contra el periodo anterior (null si no hay base para comparar). */
function variacion(actual, anterior) {
  if (!anterior) return null
  const p = ((actual - anterior) / anterior) * 100
  return { texto: `${p >= 0 ? '▲' : '▼'} ${Math.abs(p).toFixed(1)}%`, sube: p >= 0 }
}
/** Montos de la gráfica: RD$ 1.2 k, RD$ 418 k, RD$ 1.3 M. */
const compacto = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)} k` : num0(n))

export function Dashboard() {
  const navigate = useNavigate()
  const [periodo, setPeriodo] = useState('Este mes')
  const d = useApi(`/admin/dashboard?periodo=${PERIODOS[periodo]}`)
  const datos = d.data

  if (d.error && !datos) return <Page crumb="Administración · Dashboard" title="Dashboard general"><div className="alert alert-err">{d.error.message}</div></Page>
  if (!datos) return <Page crumb="Administración · Dashboard" title="Dashboard general"><div className="card muted">Cargando indicadores…</div></Page>

  const k = datos.kpis
  const vIngresos = variacion(k.ingresos, k.ingresos_anterior)
  const vSolicitudes = variacion(k.solicitudes_nuevas, k.solicitudes_anterior)
  const meses = datos.ingresos_mes.map((m) => ({ mes: MES_CORTO[Number(m.mes.slice(5, 7)) - 1], total: Number(m.total) }))
  const max = Math.max(...meses.map((m) => m.total), 1)
  const estados = Object.keys(COLOR_ESTADO).map((e) => ({ estado: e, n: datos.solicitudes_estado.find((x) => x.estado === e)?.n || 0, color: COLOR_ESTADO[e] }))
  const totalSol = estados.reduce((s, e) => s + e.n, 0)
  const gradiente = totalSol
    ? estados.map((e, i) => {
      const previo = estados.slice(0, i).reduce((s, x) => s + x.n, 0)
      return `${e.color} ${(previo / totalSol) * 360}deg ${((previo + e.n) / totalSol) * 360}deg`
    }).join(', ')
    : '#e6ebe8 0deg 360deg'
  const totalMetodos = datos.metodos.reduce((s, m) => s + Number(m.monto), 0)
  const a = datos.alertas
  const alertas = [
    a.pagos_verificacion > 0 && { clase: 'alert-warn', ir: '/admin/pagos', texto: <>⏳ <b>{a.pagos_verificacion} pago{a.pagos_verificacion === 1 ? '' : 's'}</b> en verificación (transferencia/efectivo) → Conciliar</> },
    a.prestadores_pendientes > 0 && { clase: 'alert-warn', ir: '/admin/prestadores', texto: <>🧰 <b>{a.prestadores_pendientes} prestador{a.prestadores_pendientes === 1 ? '' : 'es'}</b> esperando aprobación → Revisar</> },
    a.ecf_rechazados > 0 && { clase: 'alert-err', ir: '/admin/facturacion', texto: <>📄 <b>{a.ecf_rechazados} e-CF rechazado{a.ecf_rechazados === 1 ? '' : 's'}</b> por la DGII{a.ecf_rechazado_numero ? ` (${a.ecf_rechazado_numero})` : ''} → Corregir</> },
    a.notas_credito_pendientes > 0 && { clase: 'alert-warn', ir: '/admin/facturacion', texto: <>↩ <b>{a.notas_credito_pendientes} solicitud{a.notas_credito_pendientes === 1 ? '' : 'es'} de nota de crédito</b> por revisar → Facturación</> },
    a.facturas_sin_encf > 0 && { clase: 'alert-err', ir: '/admin/facturacion', texto: <>⚠ <b>{a.facturas_sin_encf} documento{a.facturas_sin_encf === 1 ? '' : 's'}</b> sin e-CF emitido → Reintentar emisión</> },
    a.sin_prestador > 0 && { clase: 'alert-info', ir: '/admin/solicitudes', texto: <>⚡ <b>{a.sin_prestador} solicitud{a.sin_prestador === 1 ? '' : 'es'}</b> sin prestador asignado → Asignar manualmente</> },
  ].filter(Boolean)

  return (
    <Page crumb="Administración · Dashboard" title="Dashboard general">
      <div className="row between wrap mb-16">
        <Chips valor={periodo} onChange={setPeriodo} opciones={Object.keys(PERIODOS)} />
        <span className="xs muted">
          {d.cargando ? 'Actualizando…' : `Actualizado ${new Date(datos.generado).toLocaleString('es-DO', { dateStyle: 'short', timeStyle: 'short' })}`}
          {' '}<button className="link-btn xs" onClick={d.recargar}>↻</button>
        </span>
      </div>
      <div className="grid g-4 mb-16">
        <Kpi label={`Ingresos ${TEXTO_PERIODO[periodo]}`} value={money0(k.ingresos)} foot={vIngresos ? `${vIngresos.texto} ${VS_PERIODO[periodo]}` : 'Pagos confirmados'} up={vIngresos?.sube} />
        <Kpi label="Solicitudes nuevas" value={num0(k.solicitudes_nuevas)} foot={vSolicitudes ? `${vSolicitudes.texto} ${VS_PERIODO[periodo]}` : null} up={vSolicitudes?.sube} />
        <Kpi label="Prestadores activos" value={num0(k.prestadores_activos)} foot={k.prestadores_pendientes ? `${k.prestadores_pendientes} por aprobar` : 'Ninguno por aprobar'} />
        <Kpi label="e-CF emitidos" value={num0(k.ecf_emitidos)} foot={`${k.ecf_rechazados} rechazado${k.ecf_rechazados === 1 ? '' : 's'} · ${k.ecf_en_proceso} en proceso`} />
      </div>

      <div className="split-wide mb-16">
        <div className="card">
          <div className="card-title">Ingresos por mes (RD$, últimos 6 meses)</div>
          <div className="bars">
            {meses.map((m, i) => (
              <div key={`${m.mes}${i}`} className={`b ${i === meses.length - 1 ? 'last' : ''}`} title={money0(m.total)}>
                <span className="xs muted">{m.total ? compacto(m.total) : '0'}</span>
                <div style={{ height: `${Math.max((m.total / max) * 85, m.total ? 2 : 0)}%` }} />
              </div>
            ))}
          </div>
          <div className="bars-x">{meses.map((m, i) => <span key={`${m.mes}${i}`}>{m.mes}</span>)}</div>
          <div className="xs muted mt-8">
            {totalMetodos
              ? `Por método (${TEXTO_PERIODO[periodo].replace(/^de(l)? /, '')}): ${datos.metodos.map((m) => `${m.metodo_pago} ${Math.round((Number(m.monto) / totalMetodos) * 100)}%`).join(' · ')}`
              : `Sin pagos confirmados ${TEXTO_PERIODO[periodo]}`}
          </div>
        </div>
        <div className="card">
          <div className="card-title">Solicitudes por estado</div>
          <div className="row" style={{ gap: 24, justifyContent: 'center' }}>
            <div style={{ width: 170, height: 170, borderRadius: '50%', background: `conic-gradient(${gradiente})`, display: 'grid', placeItems: 'center' }}>
              <div style={{ width: 100, height: 100, borderRadius: '50%', background: '#fff', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 20 }}>{totalSol}</div>
            </div>
            <div className="legend">
              {estados.map((e) => <div key={e.estado}><i style={{ background: e.color }} />{e.estado} <b>{e.n}</b></div>)}
            </div>
          </div>
          <div className="xs muted center mt-8">Solicitudes registradas {TEXTO_PERIODO[periodo]}</div>
        </div>
      </div>

      <div className="grid g-2">
        <div className="card">
          <div className="card-title">Servicios más solicitados</div>
          <table className="table">
            <thead><tr><th>#</th><th>Servicio</th><th>Categoría</th><th className="num">Solicitudes</th><th className="num">Facturado</th></tr></thead>
            <tbody>
              {datos.top_servicios.map((s, i) => <tr key={s.servicio}><td>{i + 1}</td><td className="semibold">{s.servicio}</td><td>{s.categoria}</td><td className="num">{s.solicitudes}</td><td className="num">{money0(s.ingresos)}</td></tr>)}
              {!datos.top_servicios.length && <tr><td colSpan={5} className="center muted">Sin solicitudes {TEXTO_PERIODO[periodo]}.</td></tr>}
            </tbody>
          </table>
          <div className="xs muted mt-8">Facturado: monto sin ITBIS de las facturas vigentes del periodo.</div>
        </div>
        <div className="card col" style={{ gap: 8 }}>
          <div className="card-title" style={{ margin: 0 }}>Alertas y pendientes</div>
          {alertas.map((x, i) => (
            <button key={i} className={`alert ${x.clase}`} style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => navigate(x.ir)}>{x.texto}</button>
          ))}
          {!alertas.length && <div className="alert alert-ok">✓ No hay pendientes. Todo está al día.</div>}
        </div>
      </div>
    </Page>
  )
}

// ADM-P03 · Aprobación de prestadores (Figura 50)
export function PrestadoresAdmin() {
  const [f, setF] = useState('Pendiente')
  const lista = useApi(`/admin/prestadores?estado=${f}`)
  const pendientes = useApi('/admin/prestadores?estado=Pendiente')
  const [selId, setSelId] = useState(null)
  const [motivo, setMotivo] = useState('')
  const [checks, setChecks] = useState([false, false, false])
  const [aviso, setAviso] = useState(null)
  const [ocupado, setOcupado] = useState(false)

  const filas = lista.data || []
  const sel = filas.find((x) => x.id_empleado === selId) || filas[0] || null
  const elegir = (x) => { setSelId(x.id_empleado); setMotivo(''); setChecks([false, false, false]); setAviso(null) }

  const verDocumento = async (d) => {
    const r = await fetch(`/api/archivos/${d.url.split('/').pop()}`, { headers: { Authorization: `Bearer ${leerSesion()?.token}` } })
    if (!r.ok) return setAviso({ tipo: 'err', texto: 'No se pudo abrir el documento' })
    window.open(URL.createObjectURL(await r.blob()), '_blank', 'noopener')
  }
  const marcarDocumento = async (i) => {
    const documentos = sel.documentos.map((d, j) => (j === i ? { ...d, estado: d.estado === 'Verificado' ? 'Revisar' : 'Verificado' } : d))
    try { await patch(`/admin/prestadores/${sel.id_empleado}/documentos`, { documentos }); lista.recargar() } catch (e) { setAviso({ tipo: 'err', texto: e.message }) }
  }
  const decidir = async (decision) => {
    setAviso(null)
    if (decision !== 'Aprobar' && !motivo.trim()) return setAviso({ tipo: 'err', texto: 'Indique el motivo para rechazar o solicitar documentos' })
    setOcupado(true)
    try {
      await post(`/admin/prestadores/${sel.id_empleado}/decision`, { decision, motivo })
      setAviso({ tipo: 'ok', texto: `${sel.nombre} ${sel.apellido}: ${{ Aprobar: 'aprobado', Rechazar: 'rechazado', 'Solicitar documento': 'se le solicitó el documento' }[decision]}. Se le notificó por correo y WhatsApp.` })
      setSelId(null)
      setMotivo('')
      lista.recargar()
      pendientes.recargar()
    } catch (e) {
      setAviso({ tipo: 'err', texto: e.message })
    } finally {
      setOcupado(false)
    }
  }
  const nPend = pendientes.data?.length || 0

  return (
    <Page crumb="Administración · Prestadores" title="Aprobación de prestadores">
      {aviso && <div className={`alert ${aviso.tipo === 'ok' ? 'alert-ok' : 'alert-err'} mb-16`}>{aviso.texto}</div>}
      <div className="split" style={{ gridTemplateColumns: '320px minmax(0,1fr)' }}>
        <div className="card">
          <div className="mb-12">
            <Chips valor={f} onChange={(v) => { setF(v); setSelId(null) }} opciones={[
              { value: 'Pendiente', label: `Pendientes${nPend ? ` (${nPend})` : ''}` }, { value: 'Aprobado', label: 'Aprobados' }, { value: 'Rechazado', label: 'Rechazados' },
            ]} />
          </div>
          {lista.error && <div className="alert alert-err small">{lista.error.message}</div>}
          {filas.map((x) => (
            <button key={x.id_empleado} className={`option-card mb-8 ${sel?.id_empleado === x.id_empleado ? 'selected' : ''}`} style={{ width: '100%', alignItems: 'center' }} onClick={() => elegir(x)}>
              <Avatar ini={`${x.nombre[0] || ''}${x.apellido[0] || ''}`} size="sm" />
              <div className="grow" style={{ textAlign: 'left' }}><div className="semibold small">{x.nombre} {x.apellido}</div><div className="xs muted">{x.categoria} · {x.especialidad}</div></div>
              <span className="xs muted">{hace(x.fecha_registro)}</span>
            </button>
          ))}
          {!filas.length && <div className="small muted">{lista.cargando ? 'Cargando…' : `No hay prestadores ${f === 'Pendiente' ? 'pendientes' : f.toLowerCase() + 's'}.`}</div>}
        </div>

        {sel ? (
          <div className="card">
            <div className="row between mb-16">
              <div className="row">
                <Avatar ini={`${sel.nombre[0] || ''}${sel.apellido[0] || ''}`} size="md" />
                <div>
                  <div className="bold" style={{ fontSize: 16 }}>{sel.nombre} {sel.apellido}</div>
                  <div className="small muted">{sel.especialidad}{sel.anios_experiencia != null ? ` · ${sel.anios_experiencia} años` : ''} · registrado {hace(sel.fecha_registro)}</div>
                </div>
              </div>
              <Badge>{sel.estado_aprobacion}</Badge>
            </div>
            <div className="grid g-2">
              <div>
                <div className="card-title">Datos registrados</div>
                <div className="kv" style={{ gridTemplateColumns: '90px 1fr' }}>
                  <div>Cédula</div><div>{formatoCedula(sel.cedula)} {cedulaValida(sel.cedula) && <span className="green">✓ válida</span>}</div>
                  <div>Correo</div><div>{sel.email}</div>
                  <div>Teléfono</div><div>{sel.telefono || '—'}</div>
                  <div>Categoría</div><div>{sel.categoria}</div>
                  <div>Servicios</div><div>{sel.servicios || '—'}</div>
                  <div>Tarifa</div><div>{sel.tarifa_hora ? `${money0(sel.tarifa_hora)} / hora` : '—'}</div>
                  <div>Zona</div><div>{sel.zona_cobertura || '—'}</div>
                  <div>Horario</div><div>{sel.horario || '—'}</div>
                </div>
                {sel.presentacion && <div className="small mt-12"><b>Presentación</b><br />{sel.presentacion}</div>}
              </div>
              <div>
                <div className="card-title">Documentos</div>
                {sel.documentos.map((d, i) => (
                  <div key={i} className="row card mb-8" style={{ padding: 9 }}>
                    <span>📄</span><span className="grow small">{d.nombre}</span>
                    <button className="link-btn xs" title="Cambiar estado" onClick={() => marcarDocumento(i)}><Badge>{d.estado}</Badge></button>
                    <button className="btn btn-outline btn-sm" onClick={() => verDocumento(d)}>Ver</button>
                  </div>
                ))}
                {!sel.documentos.length && <div className="small muted">No adjuntó documentos.</div>}
                {sel.estado_aprobacion === 'Pendiente' && (
                  <>
                    <div className="semibold small mt-12 mb-8">Lista de verificación</div>
                    {['Identidad confirmada', 'Experiencia acorde a la categoría', 'Buena conducta vigente (< 6 meses)'].map((c, i) => (
                      <label key={c} className="check mb-8"><input type="checkbox" checked={checks[i]} onChange={() => setChecks(checks.map((v, j) => (j === i ? !v : v)))} />{c}</label>
                    ))}
                  </>
                )}
              </div>
            </div>
            {sel.estado_aprobacion === 'Pendiente' && (
              <>
                <Field label="Motivo / observación" className="mt-12">
                  <input className="input" placeholder="Obligatorio si se rechaza o se solicitan documentos" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
                </Field>
                <div className="row end mt-16">
                  <button className="btn btn-danger" disabled={ocupado} onClick={() => decidir('Rechazar')}>✕ Rechazar</button>
                  <button className="btn btn-outline" disabled={ocupado} onClick={() => decidir('Solicitar documento')}>Solicitar documento</button>
                  <button className="btn btn-primary" disabled={ocupado || !checks.every(Boolean)} onClick={() => decidir('Aprobar')}>✓ Aprobar prestador</button>
                </div>
                <div className="xs muted right mt-8">Al aprobar, el prestador puede iniciar sesión, aparece en el catálogo y recibe asignaciones.</div>
              </>
            )}
          </div>
        ) : <div className="card muted">{lista.cargando ? 'Cargando…' : 'Seleccione un prestador.'}</div>}
      </div>
    </Page>
  )
}

// ADM-P04 · Usuarios y roles (Figura 51)
export function Usuarios() {
  const [lista, setLista] = useState(usuarios)
  const [matriz, setMatriz] = useState(permisos)
  const [q, setQ] = useState('')
  const [guardado, setGuardado] = useState(false)
  const toggleBloqueo = (i) => setLista(lista.map((u, j) => (j === i ? { ...u, estado: u.estado === 'Bloqueado' ? 'Activo' : 'Bloqueado' } : u)))
  const togglePerm = (i, k) => { setGuardado(false); setMatriz(matriz.map((p, j) => (j === i ? { ...p, [k]: !p[k] } : p))) }
  const filtrados = lista.filter((u) => `${u.nombre} ${u.correo}`.toLowerCase().includes(q.toLowerCase()))

  return (
    <Page crumb="Administración · Seguridad" title="Usuarios y roles">
      <div className="split-wide">
        <div className="card">
          <div className="row between wrap mb-12">
            <div className="card-title" style={{ margin: 0 }}>Usuarios</div>
            <div className="row"><input className="input" placeholder="🔍 Buscar por nombre o correo" value={q} onChange={(e) => setQ(e.target.value)} /><button className="btn btn-primary">＋ Nuevo usuario</button></div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Usuario</th><th>Correo</th><th>Rol</th><th>Último acceso</th><th>Estado</th><th /></tr></thead>
              <tbody>
                {filtrados.map((u) => {
                  const i = lista.indexOf(u)
                  return (
                    <tr key={u.correo}>
                      <td className="semibold">{u.nombre}</td><td>{u.correo}</td><td>{u.rol}</td><td className="xs">{u.acceso}</td><td><Badge>{u.estado}</Badge></td>
                      <td className="nowrap"><button className="link-btn" title="Editar">✏️</button> <button className="link-btn" title={u.estado === 'Bloqueado' ? 'Desbloquear' : 'Bloquear'} onClick={() => toggleBloqueo(i)}>{u.estado === 'Bloqueado' ? '🔓' : '🔒'}</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="xs muted mt-8">🔓 Desbloquear restablece intentos_fallidos = 0. Las contraseñas se guardan cifradas (bcrypt) y no son visibles.</div>
        </div>

        <div className="card">
          <div className="card-title">Matriz de permisos por rol</div>
          <table className="table">
            <thead><tr><th>Permiso</th><th className="center">Admin</th><th className="center">Empleado</th><th className="center">Cliente</th></tr></thead>
            <tbody>
              {matriz.map((p, i) => (
                <tr key={p.p}>
                  <td>{p.p}</td>
                  {['a', 'e', 'c'].map((k) => (
                    <td key={k} className="center"><button className="link-btn" style={{ color: p[k] ? 'var(--green-800)' : '#b6c2ba' }} onClick={() => togglePerm(i, k)}>{p[k] ? '✓' : '—'}</button></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row end mt-12">{guardado && <span className="small green">✓ Guardado</span>}<button className="btn btn-primary" onClick={() => setGuardado(true)}>Guardar cambios</button></div>
        </div>
      </div>
    </Page>
  )
}

// ADM-P05 · Reportes (Figura 52)
const REPORTES = ['Ingresos por periodo', 'Solicitudes por estado', 'Servicios más solicitados', 'Desempeño de prestadores', 'Pagos por método', 'Comprobantes e-CF emitidos (607)', 'Uso del asistente IA']

export function Reportes() {
  const [tipo, setTipo] = useState(REPORTES[0])
  const r = reporteIngresos
  return (
    <Page crumb="Administración · Reportes" title="Reportes">
      <div className="split" style={{ gridTemplateColumns: '260px minmax(0,1fr)' }}>
        <div className="card col" style={{ gap: 8 }}>
          <div className="card-title" style={{ margin: 0 }}>Tipo de reporte</div>
          {REPORTES.map((t) => (
            <label key={t} className={`option-card ${tipo === t ? 'selected' : ''}`} style={{ alignItems: 'center' }}>
              <input type="radio" checked={tipo === t} onChange={() => setTipo(t)} /><span className="small">{t}</span>
            </label>
          ))}
        </div>
        <div className="col" style={{ gap: 16 }}>
          <div className="card row wrap" style={{ alignItems: 'flex-end' }}>
            <Field label="Desde"><input className="input" type="date" defaultValue="2026-09-01" /></Field>
            <Field label="Hasta"><input className="input" type="date" defaultValue="2026-09-30" /></Field>
            <Field label="Categoría"><select className="select"><option>Todas</option><option>Técnicos</option><option>Profesionales</option><option>Hogar</option></select></Field>
            <Field label="Método de pago"><select className="select"><option>Todos</option><option>PayPal</option><option>Tarjeta</option><option>Transferencia</option><option>Efectivo</option></select></Field>
            <button className="btn btn-primary">Generar</button>
            <div className="row" style={{ marginLeft: 'auto' }}>
              <button className="btn btn-outline btn-sm">⬇ PDF</button><button className="btn btn-outline btn-sm">⬇ Excel</button><button className="btn btn-ghost btn-sm" onClick={() => window.print()}>🖨</button>
            </div>
          </div>
          <div className="card">
            <div className="bold" style={{ fontSize: 15 }}>Reporte de {tipo.toLowerCase()}</div>
            <div className="xs muted mb-12">Directorio Servicios, SRL · 01/09/2026 – 30/09/2026 · Generado por Ana Díaz</div>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Categoría</th><th className="num">Solicitudes pagadas</th><th className="num">Subtotal</th><th className="num">ITBIS</th><th className="num">Total</th><th className="num">% del total</th></tr></thead>
                <tbody>{r.categorias.map((c) => <tr key={c.cat}><td>{c.cat}</td><td className="num">{c.n}</td><td className="num">{num(c.sub)}</td><td className="num">{num(c.itbis)}</td><td className="num">{num(c.total)}</td><td className="num">{c.pct}</td></tr>)}</tbody>
                <tfoot><tr><td>TOTAL</td><td className="num">{r.total.n}</td><td className="num">{num(r.total.sub)}</td><td className="num">{num(r.total.itbis)}</td><td className="num">{num(r.total.total)}</td><td className="num">100%</td></tr></tfoot>
              </table>
            </div>
            <div className="semibold mt-16 mb-8">Por método de pago</div>
            <table className="table">
              <thead><tr><th>Método</th><th className="num">Pagos</th><th className="num">Monto</th></tr></thead>
              <tbody>{r.metodos.map((m) => <tr key={m.m}><td>{m.m}</td><td className="num">{m.n}</td><td className="num">{num(m.monto)}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      </div>
    </Page>
  )
}

export function Configuracion() {
  return (
    <Page crumb="Administración · Configuración" title="Configuración">
      <div className="grid g-2">
        <div className="card col">
          <div className="card-title" style={{ margin: 0 }}>Datos del emisor</div>
          <Field label="Razón social"><input className="input" defaultValue="Directorio Servicios, SRL" /></Field>
          <Field label="RNC"><input className="input" inputMode="numeric" defaultValue="1-32-45678-9" onInput={soloRncCedula} /></Field>
          <Field label="Dirección"><input className="input" defaultValue="Av. Winston Churchill #1100, Torre Empresarial, Piantini" /></Field>
          <Field label="Teléfono"><input className="input" inputMode="tel" defaultValue="849-880-2724" onInput={soloTelefono} /></Field>
        </div>
        <div className="card col">
          <div className="card-title" style={{ margin: 0 }}>Parámetros del sistema</div>
          <div className="form-grid">
            <Field label="ITBIS (%)"><input className="input" inputMode="decimal" defaultValue="18" onInput={soloDecimal} /></Field>
            <Field label="Tasa RD$/USD"><input className="input" inputMode="decimal" defaultValue="61.00" onInput={soloDecimal} /></Field>
            <Field label="Plazo de respuesta del prestador (h)"><input className="input" inputMode="numeric" defaultValue="2" onInput={soloEntero} /></Field>
            <Field label="Confirmación automática (h)"><input className="input" inputMode="numeric" defaultValue="48" onInput={soloEntero} /></Field>
            <Field label="Cancelación sin costo (h antes)"><input className="input" inputMode="numeric" defaultValue="12" onInput={soloEntero} /></Field>
            <Field label="Límite IA (mensajes/hora)"><input className="input" inputMode="numeric" defaultValue="30" onInput={soloEntero} /></Field>
          </div>
          <div className="row end"><button className="btn btn-primary">Guardar</button></div>
        </div>
      </div>
    </Page>
  )
}
