// MOD-CAT · Catálogo y Prestadores
// CAT-P01 Catálogo · CAT-P02 Perfil del prestador · CAT-P03 Registro de prestador · CAT-P04 Mantenimiento de servicios · CAT-P05 Planes de suscripción
import { useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Page } from '../components/Layout'
import { Avatar, Chips, Stars, Badge, Stepper, Field, Modal, PasswordInput } from '../components/ui'
import { servicios, modalidadLabel } from '../data/mock'
import { money0, money, num, dia, diaDeFecha, hace, hora12, isoDia, manana } from '../lib/format'
import { useApi } from '../lib/useApi'
import { useSession } from '../components/session'
import { post, put } from '../lib/api'
import { cedulaValida, telefonoValido, emailValido, contrasenaValida, fortaleza } from '../lib/fiscal'
import { letras, textoSinNumeros, cedula, telefono, decimal, entero, nombreValido, tarjeta as numTarjeta, vencimiento, digitos } from '../lib/filtros'

// CAT-P01 · Catálogo de servicios, inicio del cliente (Figura 32)
const normalizar = (t = '') => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

export function Catalogo() {
  const navigate = useNavigate()
  const { usuario } = useSession()
  const catalogo = useApi('/catalogo/servicios')
  const categorias = useApi('/catalogo/categorias')
  const destacados = useApi('/catalogo/prestadores?limite=3')
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('Todos')
  const [cats, setCats] = useState(null)
  const [min, setMin] = useState('')
  const [max, setMax] = useState('')
  const [cal, setCal] = useState(0)
  const [mods, setMods] = useState(['En sitio', 'Remoto / Virtual'])
  const [verPrestadores, setVerPrestadores] = useState(null)

  const todos = catalogo.data || []
  const nombresCat = (categorias.data || []).map((c) => c.nombre)
  const activas = cats ?? nombresCat
  // Búsqueda en vivo: cada letra filtra por nombre, descripción o categoría (sin distinguir acentos ni mayúsculas)
  const terminos = normalizar(q).split(/\s+/).filter(Boolean)
  const lista = todos.filter((s) =>
    (cat === 'Todos' || s.categoria === cat) &&
    activas.includes(s.categoria) &&
    (!min || s.precio_base >= Number(min)) && (!max || s.precio_base <= Number(max)) &&
    (!cal || (s.calificacion || 0) >= cal) &&
    terminos.every((t) => normalizar(`${s.nombre} ${s.descripcion || ''} ${s.categoria || ''}`).includes(t)) &&
    ((mods.includes('En sitio') && s.modalidad !== 'Remoto') || (mods.includes('Remoto / Virtual') && s.modalidad !== 'En sitio'))
  )
  const toggle = (arr, set, v) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])
  const limpiar = () => { setCats(null); setMin(''); setMax(''); setCal(0); setMods(['En sitio', 'Remoto / Virtual']); setQ(''); setCat('Todos') }
  const iconoCat = { Técnicos: '🔧', Profesionales: '💼', Hogar: '🏠' }

  return (
    <Page crumb="Inicio · Catálogo" title="Catálogo de servicios">
      <div className="hero">
        <div className="grow">
          <h2>¿Qué servicio necesitas hoy, {usuario?.nombreCorto?.split(' ')[0]}?</h2>
          <p style={{ color: '#c7dccf', fontSize: 13 }}>Busca, elige a tu prestador o deja que el sistema te asigne uno disponible.</p>
          <form className="search-big" onSubmit={(e) => e.preventDefault()}>
            <input className="input" type="search" autoComplete="off" placeholder='🔍 Ej. "reparación eléctrica"' value={q} onChange={(e) => setQ(textoSinNumeros(e.target.value).trimStart())} />
            {q && <button type="button" className="btn btn-ghost" style={{ background: '#fff' }} onClick={() => setQ('')}>✕</button>}
          </form>
          {q && <div className="xs mt-8" style={{ color: '#c7dccf' }}>{lista.length} {lista.length === 1 ? 'servicio coincide' : 'servicios coinciden'} con “{q}”</div>}
        </div>
        <div className="hero-help">
          <div className="semibold">🤖 ¿No sabes qué pedir?</div>
          <div className="xs" style={{ color: '#c7dccf', margin: '3px 0 9px' }}>El asistente te sugiere el servicio adecuado.</div>
          <button className="btn btn-sm" style={{ background: '#fff', color: 'var(--green-800)' }} onClick={() => navigate('/asistente')}>Preguntar al asistente</button>
        </div>
      </div>

      <div className="split mt-16" style={{ gridTemplateColumns: '220px minmax(0,1fr)' }}>
        <aside className="card">
          <div className="card-title">Filtros</div>
          <div className="filter-group">
            <span className="label">Categoría</span>
            {(categorias.data || []).map((c) => (
              <label key={c.id_categoria} className="check mb-8">
                <input type="checkbox" checked={activas.includes(c.nombre)} onChange={() => toggle(activas, setCats, c.nombre)} />
                {c.nombre === 'Hogar' ? 'Hogar' : `Servicios ${c.nombre.toLowerCase()}`} ({c.total})
              </label>
            ))}
          </div>
          <div className="filter-group">
            <span className="label">Precio base (RD$)</span>
            <div className="row">
              <input className="input" inputMode="numeric" placeholder="Mín." value={min} onChange={(e) => setMin(entero(e.target.value, 7))} />
              <span className="muted">–</span>
              <input className="input" inputMode="numeric" placeholder="Máx." value={max} onChange={(e) => setMax(entero(e.target.value, 7))} />
            </div>
          </div>
          <div className="filter-group">
            <span className="label">Calificación mínima</span>
            <div className="row" style={{ gap: 2 }}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} className="link-btn" style={{ color: n <= cal ? '#e8a317' : '#c9d2cc', fontSize: 17 }} onClick={() => setCal(cal === n ? 0 : n)}>★</button>
              ))}
            </div>
            <div className="xs muted">{cal ? `${cal}.0 o más` : 'Cualquiera'}</div>
          </div>
          <div className="filter-group">
            <span className="label">Modalidad</span>
            {['En sitio', 'Remoto / Virtual'].map((m) => (
              <label key={m} className="check mb-8"><input type="checkbox" checked={mods.includes(m)} onChange={() => toggle(mods, setMods, m)} />{m}</label>
            ))}
          </div>
          <button className="btn btn-outline btn-block btn-sm" onClick={limpiar}>Limpiar filtros</button>
        </aside>

        <div>
          <div className="row between wrap mb-12">
            <Chips valor={cat} onChange={setCat} opciones={[{ value: 'Todos', label: 'Todos' }, ...nombresCat.map((c) => ({ value: c, label: `${iconoCat[c] || ''} ${c}` }))]} />
            <span className="small muted">{lista.length} servicios · Ordenar por: <b className="green">Más solicitados</b></span>
          </div>
          {catalogo.error && <div className="alert alert-err mb-12">{catalogo.error.message}</div>}

          <div className="grid g-3">
            {lista.map((s) => (
              <div key={s.id_servicio} className="card service-card">
                <div className="service-img">{s.icono || iconoCat[s.categoria] || '🛠️'}</div>
                <div className="row between"><span className="cat-pill">{s.categoria}</span><span className="xs muted">{modalidadLabel({ cat: s.categoria, modalidad: s.modalidad })}</span></div>
                <div className="semibold">{s.nombre}</div>
                <div className="xs muted">{s.calificacion ? <><span className="rating">★</span> {s.calificacion} · </> : ''}{s.prestadores} prestadores</div>
                <div className="row between" style={{ alignItems: 'flex-end' }}>
                  <div><div className="price-label">Desde</div><div className="price">{money0(s.precio_base)}</div></div>
                  <button className="btn btn-primary btn-sm" onClick={() => navigate(`/solicitudes/nueva?servicio=${s.id_servicio}`)}>Solicitar servicio</button>
                </div>
                {s.prestadores > 0 && <button className="link-btn small" style={{ textAlign: 'left' }} onClick={() => setVerPrestadores(s)}>Ver prestadores ({s.prestadores}) →</button>}
              </div>
            ))}
            {!lista.length && <div className="card muted">{catalogo.cargando ? 'Cargando catálogo…' : 'No hay servicios con esos filtros.'}</div>}
          </div>

          <div className="card mt-16">
            <div className="card-title">⭐ Prestadores destacados</div>
            <div className="grid g-3">
              {(destacados.data || []).map((p) => (
                <div key={p.id_empleado} className="row">
                  <Avatar ini={`${p.nombre[0]}${p.apellido[0]}`} />
                  <div className="grow">
                    <div className="semibold small">{p.nombre} {p.apellido} {p.destacado ? <Badge color="yellow">Destacado</Badge> : null}</div>
                    <div className="xs muted">{p.especialidad} · <Stars n={p.calificacion_promedio} size={10} /> {p.calificacion_promedio} · {money0(p.tarifa_hora)}/h</div>
                  </div>
                  <button className="btn btn-outline btn-sm" onClick={() => navigate(`/prestadores/${p.id_empleado}`)}>Ver perfil</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      {verPrestadores && <ListaPrestadores servicio={verPrestadores} onClose={() => setVerPrestadores(null)} />}
    </Page>
  )
}

export function ListaPrestadores({ servicio, onClose }) {
  const navigate = useNavigate()
  const lista = useApi(`/catalogo/prestadores?servicio=${servicio.id_servicio}`)
  return (
    <Modal titulo={`Prestadores · ${servicio.nombre}`} onClose={onClose}>
      {(lista.data || []).map((p) => (
        <div key={p.id_empleado} className="row" style={{ padding: '8px 0', borderBottom: '1px solid #edf1ee' }}>
          <Avatar ini={`${p.nombre[0]}${p.apellido[0]}`} size="sm" />
          <div className="grow"><div className="semibold small">{p.nombre} {p.apellido} {p.destacado ? <Badge color="yellow">Destacado</Badge> : null}</div><div className="xs muted">★ {p.calificacion_promedio} ({p.total_resenas}) · {money0(p.tarifa_hora)}/h · {p.zona_cobertura}</div></div>
          <button className="btn btn-outline btn-sm" onClick={() => navigate(`/prestadores/${p.id_empleado}?servicio=${servicio.id_servicio}`)}>Ver perfil</button>
        </div>
      ))}
      {lista.cargando && <div className="muted small">Cargando…</div>}
    </Modal>
  )
}

// CAT-P02 · Perfil del prestador (Figura 33)
const HORARIOS = ['08:00', '10:00', '14:00', '16:00']

export function PerfilPrestador() {
  const navigate = useNavigate()
  const { slug } = useParams()
  const [params] = useSearchParams()
  const perfil = useApi(`/catalogo/prestadores/${slug}`)
  const p = perfil.data
  const hoy = isoDia()
  const [sel, setSel] = useState(null)
  const [diaSel, setDiaSel] = useState(manana)
  const [slot, setSlot] = useState('10:00')

  if (perfil.error) return <Page crumb="Catálogo · Prestador" title="Perfil del prestador"><div className="alert alert-err">{perfil.error.message}</div></Page>
  if (!p) return <Page crumb="Catálogo · Prestador" title="Perfil del prestador"><div className="card muted">Cargando…</div></Page>

  const servicioSel = p.servicios.find((s) => s.id_servicio === (sel ?? Number(params.get('servicio')))) || p.servicios[0]
  const ocupadas = (fecha) => p.ocupado.filter((o) => o.fecha === fecha).map((o) => o.hora)
  const base = new Date(`${hoy}T12:00:00`)
  const dias = Array.from({ length: 28 }, (_, i) => isoDia(new Date(base.getTime() + i * 864e5)))
  const libres = HORARIOS.filter((h) => !ocupadas(diaSel).includes(h))

  return (
    <Page crumb={`Catálogo · ${p.nombre} ${p.apellido}`} title="Perfil del prestador">
      <div className="split">
        <div className="col" style={{ gap: 16 }}>
          <div className="card">
            <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
              <Avatar ini={`${p.nombre[0]}${p.apellido[0]}`} size="lg" />
              <div className="grow">
                <div className="row wrap"><h2 style={{ fontSize: 19 }}>{p.nombre} {p.apellido}</h2><Badge>✓ Verificado</Badge></div>
                <div className="small muted">{p.especialidad}{p.anios_experiencia ? ` · ${p.anios_experiencia} años de experiencia` : ''}</div>
                <div className="row wrap small mt-8" style={{ gap: 16 }}>
                  <span><Stars n={p.calificacion_promedio} /> <b>{p.calificacion_promedio}</b> <span className="muted">({p.total_resenas} reseñas)</span></span>
                  {p.zona_cobertura && <span>📍 {p.zona_cobertura}</span>}
                  <Badge>{p.estado_disponibilidad === 'Disponible' ? '● Disponible' : p.estado_disponibilidad}</Badge>
                </div>
              </div>
              <div className="right">
                <div className="xs muted">Tarifa por hora</div>
                <div className="price" style={{ fontSize: 20 }}>{money0(p.tarifa_hora)}</div>
              </div>
            </div>
            {p.presentacion && <p className="small mt-12">{p.presentacion}</p>}
          </div>

          <div className="card">
            <div className="card-title">Servicios que ofrece</div>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Servicio</th><th>Modalidad</th><th>Duración est.</th><th className="num">Precio base</th><th /></tr></thead>
                <tbody>
                  {p.servicios.map((s) => (
                    <tr key={s.id_servicio} className="clickable" onClick={() => setSel(s.id_servicio)}>
                      <td className={servicioSel?.id_servicio === s.id_servicio ? 'semibold' : ''}>{s.nombre}</td>
                      <td>{s.modalidad}</td><td>{s.duracion_estimada ? `${s.duracion_estimada / 60} h` : '—'}</td><td className="num">{money(s.precio_base)}</td>
                      <td><input type="radio" readOnly checked={servicioSel?.id_servicio === s.id_servicio} style={{ accentColor: 'var(--green-800)' }} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-title">Reseñas recientes</div>
            {p.resenas.map((r, i) => (
              <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid #edf1ee' }}>
                <div className="small"><b>{r.autor}</b> <Stars n={r.estrellas} size={11} /> <span className="xs muted">· {hace(r.fecha)}</span></div>
                {r.texto && <div className="small">{r.texto}</div>}
              </div>
            ))}
            {!p.resenas.length && <div className="small muted">Todavía no tiene reseñas en la plataforma.</div>}
          </div>
        </div>

        <div className="col" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-title">📅 Disponibilidad</div>
            <div className="small muted mb-8">Próximas 4 semanas · {p.horario || 'Lunes a sábado'}</div>
            <div className="cal">
              {['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((d, i) => <div key={i} className="cal-h">{d}</div>)}
              {dias.map((f, i) => {
                const domingo = new Date(`${f}T12:00:00`).getDay() === 0
                const lleno = ocupadas(f).length >= HORARIOS.length
                const col = ((new Date(`${f}T12:00:00`).getDay() + 6) % 7) + 1
                return (
                  <button key={f} disabled={domingo || lleno} onClick={() => setDiaSel(f)}
                    className={`cal-d ${domingo ? 'off' : ''} ${lleno ? 'busy' : ''} ${diaSel === f ? 'sel' : ''}`}
                    style={i === 0 ? { gridColumnStart: col } : undefined}>{Number(f.slice(8))}</button>
                )
              })}
            </div>
            <div className="row xs muted mt-8" style={{ gap: 12 }}>
              <span><span style={{ color: 'var(--green-600)' }}>■</span> Disponible</span>
              <span><span style={{ color: 'var(--red)' }}>■</span> Ocupado</span>
              <span>■ Seleccionado</span>
            </div>
            <div className="semibold small mt-12 mb-8">Horarios del {diaDeFecha(diaSel)} {dia(diaSel)}</div>
            <div className="row wrap" style={{ gap: 6 }}>
              {libres.map((h) => <button key={h} className={`slot ${slot === h ? 'sel' : ''}`} onClick={() => setSlot(h)}>{hora12(h)}</button>)}
              {!libres.length && <span className="small muted">Sin horarios libres.</span>}
            </div>
          </div>

          {servicioSel && (
            <div className="card">
              <div className="xs muted">Servicio seleccionado</div>
              <div className="semibold">{servicioSel.nombre}</div>
              <div className="row between mt-8"><span className="small muted">Desde</span><span className="price">{money(servicioSel.precio_base)}</span></div>
              <div className="xs muted">+ ITBIS 18% al facturar</div>
              <button className="btn btn-primary btn-block btn-lg mt-12"
                onClick={() => navigate(`/solicitudes/nueva?servicio=${servicioSel.id_servicio}&prestador=${p.id_empleado}&fecha=${diaSel}&hora=${libres.includes(slot) ? slot : libres[0] || '10:00'}`)}>
                Elegir prestador
              </button>
              <div className="xs muted mt-8">Se guarda en <b>v_prestadorSeleccionado</b> y abre la solicitud con el servicio precargado.</div>
            </div>
          )}
        </div>
      </div>
    </Page>
  )
}

// CAT-P03 · Registro de prestador, asistente de 4 pasos (Figura 34)
const PASOS = ['Datos personales', 'Especialidad y tarifa', 'Documentos', 'Enviar']

// Sectores de Santiago de los Caballeros
const ZONAS = ['Centro de la Ciudad', 'Los Jardines Metropolitanos', 'Cerros de Gurabo', 'Villa Olga', 'La Trinitaria', 'Reparto del Este',
  'Gurabo', 'Pueblo Nuevo', 'Los Pepines', 'Cienfuegos', 'Pekín', 'Bella Terra', 'Ensanche Bermúdez', 'Los Salados', 'Rincón Largo', 'Villa María', 'Baracoa', 'Hoya del Caimito']

const DOCUMENTOS = ['Cédula (ambos lados)', 'Certificado técnico / título', 'Certificado de buena conducta']
const ICONO_CAT = { Técnicos: '🔧', Profesionales: '💼', Hogar: '🏠' }
const MAX_ARCHIVO = 5 * 1024 * 1024

// Campos de cada paso (para volver al paso donde está el error que devuelve el servidor)
const CAMPOS_PASO = [
  ['nombre', 'apellido', 'cedula', 'telefono', 'email', 'contrasena', 'confirmar'],
  ['id_categoria', 'especialidad', 'servicios', 'tarifa_hora', 'anios_experiencia', 'zona_cobertura', 'horario', 'presentacion'],
  ['documentos'],
  ['declaracion'],
]

export function RegistroPrestador() {
  const navigate = useNavigate()
  const categorias = useApi('/catalogo/categorias')
  const catalogo = useApi('/catalogo/servicios')
  const [paso, setPaso] = useState(0)
  const [f, setF] = useState({
    nombre: '', apellido: '', cedula: '', telefono: '', email: '', contrasena: '', confirmar: '',
    id_categoria: null, especialidad: '', tarifa_hora: '', anios_experiencia: '', horario: 'Lunes a sábado · 8:00 a. m. – 6:00 p. m.', presentacion: '',
  })
  const [servs, setServs] = useState([])
  const [zonas, setZonas] = useState([])
  const [docs, setDocs] = useState([null, null, null])
  const [declara, setDeclara] = useState(false)
  const [errores, setErrores] = useState({})
  const [errorGeneral, setErrorGeneral] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [enviado, setEnviado] = useState(false)

  const set = (campo, filtro) => (e) => setF({ ...f, [campo]: filtro ? filtro(e.target.value) : e.target.value })
  const toggle = (arr, setArr, v) => setArr(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])
  const cats = categorias.data || []
  const catSel = cats.find((c) => c.id_categoria === f.id_categoria)
  const serviciosCat = (catalogo.data || []).filter((s) => s.id_categoria === f.id_categoria)

  /** Validación del paso (mismas reglas que el servidor). */
  const validarPaso = (p) => {
    const e = {}
    if (p === 0) {
      if (!nombreValido(f.nombre)) e.nombre = 'Indique su nombre (solo letras)'
      if (!nombreValido(f.apellido)) e.apellido = 'Indique su apellido (solo letras)'
      if (!cedulaValida(f.cedula)) e.cedula = 'Cédula inválida (11 dígitos)'
      if (!telefonoValido(f.telefono)) e.telefono = 'Teléfono inválido (809, 829 u 849 + 7 dígitos)'
      if (!emailValido(f.email)) e.email = 'Formato de correo inválido'
      if (!contrasenaValida(f.contrasena)) e.contrasena = 'Mínimo 8 caracteres, una mayúscula y un número'
      if (f.confirmar !== f.contrasena) e.confirmar = 'Las contraseñas no coinciden'
    }
    if (p === 1) {
      if (!f.id_categoria) e.id_categoria = 'Seleccione la categoría principal'
      if (!f.especialidad.trim()) e.especialidad = 'Indique su especialidad'
      if (!servs.length) e.servicios = 'Seleccione al menos un servicio'
      if (!(Number(f.tarifa_hora) > 0 && Number(f.tarifa_hora) <= 50000)) e.tarifa_hora = 'Indique su tarifa por hora'
      if (f.anios_experiencia !== '' && !(Number(f.anios_experiencia) >= 0 && Number(f.anios_experiencia) <= 60)) e.anios_experiencia = 'Años inválidos'
      if (!zonas.length) e.zona_cobertura = 'Seleccione al menos un sector'
    }
    if (p === 2) {
      if (!docs[0]) e.documentos = 'Adjunte al menos la cédula'
      if (docs.some((d) => d && d.size > MAX_ARCHIVO)) e.documentos = 'Cada archivo debe pesar 5 MB o menos'
    }
    if (p === 3 && !declara) e.declaracion = 'Debe declarar que la información es verídica'
    setErrores(e)
    return !Object.keys(e).length
  }
  const siguiente = () => { if (validarPaso(paso)) setPaso(paso + 1) }

  const enviar = async () => {
    setErrorGeneral('')
    if (!validarPaso(3)) return
    setEnviando(true)
    try {
      const fd = new FormData()
      for (const k of ['nombre', 'apellido', 'cedula', 'telefono', 'email', 'contrasena', 'especialidad', 'tarifa_hora', 'anios_experiencia', 'horario', 'presentacion']) fd.append(k, String(f[k]).trim())
      fd.append('id_categoria', String(f.id_categoria))
      for (const s of servs) fd.append('servicios', String(s))
      fd.append('zona_cobertura', zonas.join(', '))
      docs.forEach((d, i) => { if (d) { fd.append('documentos', d); fd.append('nombres_documentos', DOCUMENTOS[i]) } })
      await post('/auth/registro-prestador', fd)
      setEnviado(true)
    } catch (e) {
      // Lleva al paso donde está el primer error del servidor
      const detalles = e.detalles || {}
      setErrores(detalles)
      const p = CAMPOS_PASO.findIndex((campos) => campos.some((c) => detalles[c]))
      if (p >= 0) setPaso(p)
      else if (/correo/i.test(e.message)) { setErrores({ email: e.message }); setPaso(0) }
      else if (/c[ée]dula/i.test(e.message)) { setErrores({ cedula: e.message }); setPaso(0) }
      setErrorGeneral(e.message)
    } finally {
      setEnviando(false)
    }
  }

  if (enviado) {
    return (
      <div className="center-page">
        <div className="card center" style={{ maxWidth: 480, alignSelf: 'flex-start', padding: 32 }}>
          <div style={{ fontSize: 40 }}>⏳</div>
          <h2 className="mt-8">Solicitud enviada</h2>
          <p className="muted mt-8">Gracias, {f.nombre.trim()}. Tu perfil quedó <b>pendiente de aprobación</b>. Un administrador revisará tus documentos y te avisaremos por correo y WhatsApp.</p>
          <p className="xs muted mt-8">Podrás iniciar sesión con <b>{f.email.trim().toLowerCase()}</b> cuando tu perfil sea aprobado.</p>
          <button className="btn btn-primary mt-20" onClick={() => navigate('/login')}>Volver al inicio</button>
        </div>
      </div>
    )
  }

  return (
    <div className="center-page">
      <div className="card" style={{ maxWidth: 980, width: '100%', alignSelf: 'flex-start', padding: 26 }}>
        <div className="row between mb-16">
          <div>
            <h2 style={{ fontSize: 19 }}>Únete como prestador de servicios</h2>
            <p className="muted small">Completa tu perfil. Un administrador lo revisará antes de publicarlo en el catálogo.</p>
          </div>
          <Badge color="yellow">Paso {paso + 1} de {PASOS.length}</Badge>
        </div>
        <Stepper pasos={PASOS} actual={paso} />

        {paso === 0 && (
          <div className="form-grid">
            <Field label="Nombre(s)" req error={errores.nombre}><input className="input" autoComplete="given-name" value={f.nombre} onChange={set('nombre', letras)} /></Field>
            <Field label="Apellido(s)" req error={errores.apellido}><input className="input" autoComplete="family-name" value={f.apellido} onChange={set('apellido', letras)} /></Field>
            <Field label="Cédula" req hint="11 dígitos; no puede estar registrada." error={errores.cedula}><input className="input" inputMode="numeric" value={f.cedula} placeholder="000-0000000-0" onChange={set('cedula', cedula)} /></Field>
            <Field label="Teléfono / WhatsApp" req error={errores.telefono}><input className="input" inputMode="tel" autoComplete="tel" value={f.telefono} placeholder="809-555-0000" onChange={set('telefono', telefono)} /></Field>
            <Field label="Correo electrónico" req hint="Será tu usuario para iniciar sesión." error={errores.email}><input className="input" type="email" autoComplete="email" value={f.email} onChange={set('email')} /></Field>
            <div />
            <Field label="Contraseña" req hint={f.contrasena ? `Seguridad: ${fortaleza(f.contrasena)}` : 'Mínimo 8 caracteres, una mayúscula y un número'} error={errores.contrasena}>
              <PasswordInput autoComplete="new-password" value={f.contrasena} onChange={set('contrasena')} />
            </Field>
            <Field label="Confirmar contraseña" req error={errores.confirmar}><PasswordInput autoComplete="new-password" value={f.confirmar} onChange={set('confirmar')} /></Field>
          </div>
        )}

        {paso === 1 && (
          <div className="grid g-2" style={{ gap: 20 }}>
            <div className="col">
              <div>
                <div className="label mb-8">Categoría principal <span className="req">*</span></div>
                <div className="grid g-3" style={{ gap: 8 }}>
                  {cats.map((c) => (
                    <label key={c.id_categoria} className={`option-card ${f.id_categoria === c.id_categoria ? 'selected' : ''}`} style={{ alignItems: 'center' }}>
                      <input type="radio" checked={f.id_categoria === c.id_categoria} onChange={() => { setF({ ...f, id_categoria: c.id_categoria }); setServs([]) }} />
                      <span className="small">{ICONO_CAT[c.nombre] || '•'} {c.nombre}</span>
                    </label>
                  ))}
                </div>
                {errores.id_categoria && <span className="error">⚠ {errores.id_categoria}</span>}
              </div>
              <Field label="Especialidad" req error={errores.especialidad}><input className="input" maxLength={100} placeholder="Ej.: Electricista residencial y comercial" value={f.especialidad} onChange={set('especialidad', textoSinNumeros)} /></Field>
              <div>
                <div className="label mb-8">Servicios que ofrecerá (del catálogo) <span className="req">*</span></div>
                {!f.id_categoria ? <div className="xs muted">Primero elija la categoría.</div> : (
                  <div className="row wrap" style={{ gap: 6 }}>
                    {serviciosCat.map((s) => (
                      <button key={s.id_servicio} type="button" className={`chip ${servs.includes(s.id_servicio) ? 'active' : ''}`} onClick={() => toggle(servs, setServs, s.id_servicio)}>
                        {s.nombre}{servs.includes(s.id_servicio) ? ' ✓' : ''}
                      </button>
                    ))}
                    {!serviciosCat.length && <span className="xs muted">No hay servicios publicados en {catSel?.nombre}.</span>}
                  </div>
                )}
                {errores.servicios && <span className="error">⚠ {errores.servicios}</span>}
              </div>
              <div className="form-grid">
                <Field label="Tarifa por hora (RD$)" req error={errores.tarifa_hora}><input className="input" inputMode="decimal" placeholder="900.00" value={f.tarifa_hora} onChange={set('tarifa_hora', decimal)} /></Field>
                <Field label="Años de experiencia" error={errores.anios_experiencia}><input className="input" inputMode="numeric" value={f.anios_experiencia} onChange={set('anios_experiencia', (v) => entero(v, 2))} /></Field>
              </div>
            </div>
            <div className="col">
              <div>
                <div className="label mb-8">Zona de cobertura (sectores de Santiago) <span className="req">*</span></div>
                <div className="row wrap" style={{ gap: 6 }}>
                  {ZONAS.map((z) => (
                    <button key={z} type="button" className={`chip ${zonas.includes(z) ? 'active' : ''}`} onClick={() => toggle(zonas, setZonas, z)}>
                      {z}{zonas.includes(z) ? ' ✕' : ''}
                    </button>
                  ))}
                </div>
                {errores.zona_cobertura && <span className="error">⚠ {errores.zona_cobertura}</span>}
              </div>
              <Field label="Horario de trabajo"><input className="input" maxLength={100} value={f.horario} onChange={set('horario')} /></Field>
              <Field label="Presentación (se muestra en tu perfil)" hint={`${f.presentacion.length}/500`}>
                <textarea className="textarea" maxLength={500} placeholder="Cuéntale a los clientes sobre tu experiencia y garantía…" value={f.presentacion} onChange={set('presentacion')} />
              </Field>
            </div>
          </div>
        )}

        {paso === 2 && (
          <div className="col">
            {DOCUMENTOS.map((d, i) => (
              <div key={d} className="row between card" style={{ padding: 12 }}>
                <div>
                  <div className="semibold">📄 {d}{i === 0 && <span className="req"> *</span>}</div>
                  <div className="xs muted">{docs[i] ? `✓ ${docs[i].name} (${Math.round(docs[i].size / 1024)} KB)` : 'PDF, JPG o PNG · máximo 5 MB'}</div>
                </div>
                <div className="row">
                  {docs[i] && <button type="button" className="link-btn xs" onClick={() => setDocs(docs.map((x, j) => (j === i ? null : x)))}>Quitar</button>}
                  <label className="btn btn-outline btn-sm">{docs[i] ? 'Cambiar' : 'Adjuntar'}
                    <input type="file" accept=".pdf,.jpg,.jpeg,.png" hidden onChange={(e) => { const a = e.target.files[0] || null; setDocs(docs.map((x, j) => (j === i ? a : x))) }} />
                  </label>
                </div>
              </div>
            ))}
            {errores.documentos && <div className="alert alert-err">{errores.documentos}</div>}
          </div>
        )}

        {paso === 3 && (
          <div className="col">
            <div className="kv">
              <div>Nombre</div><div>{f.nombre} {f.apellido}</div>
              <div>Cédula</div><div>{f.cedula}</div>
              <div>Contacto</div><div>{f.email} · {f.telefono}</div>
              <div>Categoría</div><div>{catSel?.nombre} · {f.especialidad}</div>
              <div>Servicios</div><div>{serviciosCat.filter((s) => servs.includes(s.id_servicio)).map((s) => s.nombre).join(', ')}</div>
              <div>Tarifa</div><div>{money(f.tarifa_hora)} por hora{f.anios_experiencia !== '' ? ` · ${f.anios_experiencia} años de experiencia` : ''}</div>
              <div>Zonas</div><div>{zonas.join(', ')}</div>
              <div>Documentos</div><div>{docs.filter(Boolean).length} adjunto(s)</div>
            </div>
            <label className="check"><input type="checkbox" checked={declara} onChange={(e) => setDeclara(e.target.checked)} /> Declaro que la información suministrada es verídica.</label>
            {errores.declaracion && <span className="error">⚠ {errores.declaracion}</span>}
          </div>
        )}

        {errorGeneral && <div className="alert alert-err mt-16">{errorGeneral}</div>}

        <div className="grid g-3 mt-20" style={{ gap: 12 }}>
          <div className="card" style={{ padding: 12, background: 'var(--green-50)' }}>
            <div className="semibold small">📄 Documentos (paso 3)</div>
            <div className="xs muted">Cédula (ambos lados), certificado técnico/título, certificado de buena conducta. PDF/JPG ≤ 5 MB.</div>
          </div>
          <div className="alert alert-warn xs">⏳ Al enviar, tu perfil queda <b>pendiente de aprobación</b> y se notifica a administración.</div>
          <div className="alert alert-info xs">📲 Recibirás un correo y un WhatsApp cuando tu perfil sea aprobado o si falta algún documento.</div>
        </div>

        <div className="row end mt-20">
          <button className="btn btn-ghost" disabled={paso === 0 || enviando} onClick={() => { setErrores({}); setPaso(paso - 1) }}>← Anterior</button>
          <button className="btn btn-outline" disabled={enviando} onClick={() => navigate('/login')}>Cancelar</button>
          {paso < 3
            ? <button className="btn btn-primary" onClick={siguiente}>Siguiente: {PASOS[paso + 1]} →</button>
            : <button className="btn btn-primary" disabled={enviando} onClick={enviar}>{enviando ? 'Enviando…' : 'Enviar solicitud'}</button>}
        </div>
      </div>
    </div>
  )
}

// CAT-P04 · Mantenimiento de servicios (Figura 35)
export function CatalogoAdmin() {
  const [cat, setCat] = useState('Todos')
  const [form, setForm] = useState({ cat: 'Hogar', nombre: 'Fumigación residencial', desc: 'Control de cucarachas, hormigas y roedores. Incluye garantía de 60 días.', precio: '3,200.00', dur: 120, mod: 'En sitio', itbis: 'Sí' })
  const [msg, setMsg] = useState('')
  const lista = servicios.filter((s) => cat === 'Todos' || s.cat === cat)
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })
  const precioOk = Number(String(form.precio).replace(/,/g, '')) > 0
  const guardar = (estado) => setMsg(precioOk && form.nombre.trim() ? `Servicio guardado como ${estado}.` : 'Complete los campos obligatorios.')

  return (
    <Page crumb="Administración · Catálogo" title="Catálogo y servicios">
      <div className="split" style={{ gridTemplateColumns: 'minmax(0,1fr) 360px' }}>
        <div className="card">
          <div className="row between wrap mb-12">
            <Chips valor={cat} onChange={setCat} opciones={[
              { value: 'Todos', label: 'Todos (57)' }, { value: 'Técnicos', label: 'Técnicos (24)' },
              { value: 'Profesionales', label: 'Profesionales (15)' }, { value: 'Hogar', label: 'Hogar (18)' },
            ]} />
            <button className="btn btn-primary" onClick={() => setForm({ cat: 'Técnicos', nombre: '', desc: '', precio: '', dur: 60, mod: 'En sitio', itbis: 'Sí' })}>＋ Nuevo servicio</button>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Código</th><th>Servicio</th><th>Categoría</th><th>Modalidad</th><th className="num">Precio base</th><th>ITBIS</th><th>Estado</th><th /></tr></thead>
              <tbody>
                {lista.map((s) => (
                  <tr key={s.id}>
                    <td className="muted">{s.codigo}</td><td className="semibold">{s.corto || s.nombre}</td><td>{s.cat}</td><td>{s.modalidad}</td>
                    <td className="num">RD$ {num(s.precio)}</td><td>{s.itbis ? 'Sí' : 'No'}</td><td><Badge>{s.estado}</Badge></td>
                    <td className="nowrap"><button className="link-btn" title="Editar" onClick={() => setForm({ cat: s.cat, nombre: s.nombre, desc: '', precio: num(s.precio), dur: s.duracion, mod: s.modalidad, itbis: s.itbis ? 'Sí' : 'No' })}>✏️</button> <button className="link-btn" title="Inactivar">⏸</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row between xs muted mt-12"><span>Mostrando 1–{lista.length} de 57</span><span>‹ 1 2 3 … 8 ›</span></div>
        </div>

        <div className="card col">
          <div className="card-title" style={{ margin: 0 }}>{form.nombre ? 'Editar servicio' : 'Nuevo servicio'}</div>
          <Field label="Categoría" req><select className="select" value={form.cat} onChange={set('cat')}><option>Técnicos</option><option>Profesionales</option><option>Hogar</option></select></Field>
          <Field label="Nombre del servicio" req hint="Debe ser único dentro de la categoría."><input className="input" value={form.nombre} onChange={set('nombre')} /></Field>
          <Field label="Descripción"><textarea className="textarea" value={form.desc} onChange={set('desc')} /></Field>
          <div className="form-grid">
            <Field label="Precio base (RD$)" req error={!precioOk && form.precio !== '' ? 'El precio debe ser mayor que cero' : null}><input className="input" inputMode="decimal" value={form.precio} onChange={(e) => setForm({ ...form, precio: decimal(e.target.value) })} /></Field>
            <Field label="Duración (min)"><input className="input" inputMode="numeric" value={form.dur} onChange={(e) => setForm({ ...form, dur: entero(e.target.value, 4) })} /></Field>
            <Field label="Modalidad" req><select className="select" value={form.mod} onChange={set('mod')}><option>En sitio</option><option>Remoto</option><option>Ambas</option></select></Field>
            <Field label="Aplica ITBIS 18%"><select className="select" value={form.itbis} onChange={set('itbis')}><option>Sí</option><option>No</option></select></Field>
          </div>
          <div className="alert alert-info xs">Al publicar, el servicio aparece en el catálogo del cliente y se agrega a <b>v_contextoCatalogo</b> del asistente IA.</div>
          {msg && <div className={`alert ${msg.startsWith('Servicio') ? 'alert-ok' : 'alert-err'}`}>{msg}</div>}
          <div className="row end">
            <button className="btn btn-ghost">Cancelar</button>
            <button className="btn btn-outline" onClick={() => guardar('Borrador')}>Guardar borrador</button>
            <button className="btn btn-primary" onClick={() => guardar('Publicado')}>Publicar</button>
          </div>
        </div>
      </div>
    </Page>
  )
}

// CAT-P05 · Planes de suscripción (Figura 36)
const MESES_PLAN = { Mensual: 1, Trimestral: 3, Anual: 12 }
const PERIODO_TXT = { Mensual: 'mes', Trimestral: 'trimestre', Anual: 'año' }

/** Beneficios del plan: servicios incluidos y descuentos (cliente) o condiciones de la membresía (prestador). */
const beneficios = (p) => (p.dirigido_a === 'Prestador'
  ? [
      p.comision_pct != null && `Comisión de ${Number(p.comision_pct)} % por servicio`,
      p.prioridad_asignacion && 'Prioridad en la asignación automática',
      p.destacado && 'Perfil destacado en el catálogo',
    ].filter(Boolean)
  : p.servicios.map((s) => (s.cantidad_incluida > 0
    ? `${s.cantidad_incluida} ${s.nombre.toLowerCase()} incluido${s.cantidad_incluida === 1 ? '' : 's'} por ${PERIODO_TXT[p.periodicidad]}`
    : `${Number(s.descuento_pct)} % de descuento en ${s.nombre.toLowerCase()}`)))

/** Pago de un plan con tarjeta (la pasarela procesa los datos; aquí solo se envían los últimos 4 dígitos). */
function PagarPlanTarjeta({ plan, onClose, onListo }) {
  const [t, setT] = useState({ numero: '', venc: '', cvv: '', nombre: '' })
  const [error, setError] = useState('')
  const [enviando, setEnviando] = useState(false)
  const meses = MESES_PLAN[plan.periodicidad] || 1
  const total = Math.round(Number(plan.precio_mensual) * meses * 1.18 * 100) / 100
  const pagar = async (e) => {
    e.preventDefault()
    setError('')
    const dig = t.numero.replace(/\D/g, '')
    if (dig.length < 13) return setError('Número de tarjeta inválido')
    if (!/^\d{2}\/\d{2}$/.test(t.venc)) return setError('Indique el vencimiento (MM/AA)')
    if (t.cvv.length < 3) return setError('Indique el CVV')
    setEnviando(true)
    try {
      const s = await post('/suscripciones', { id_plan: plan.id_plan, metodo_pago: 'Tarjeta' })
      await post(`/pagos/${s.id_pago}/tarjeta`, { ultimos4: dig.slice(-4) })
      onListo(`¡Listo! Tu ${plan.dirigido_a === 'Prestador' ? 'membresía' : 'plan'} ${plan.nombre} está activ${plan.dirigido_a === 'Prestador' ? 'a' : 'o'}. La factura electrónica llegará a Mis facturas.`)
    } catch (e2) {
      setError(e2.message)
    } finally {
      setEnviando(false)
    }
  }
  return (
    <Modal titulo={`Suscribirme a ${plan.nombre} con tarjeta`} onClose={onClose}>
      <div className="small mb-12">Total a pagar: <b>{money(total)}</b> ({money(plan.precio_mensual)} × {meses} {meses === 1 ? 'mes' : 'meses'} + ITBIS 18 %)</div>
      <form className="col" onSubmit={pagar}>
        <Field label="Número de tarjeta"><input className="input" inputMode="numeric" autoComplete="cc-number" placeholder="4111 1111 1111 1111" value={t.numero} onChange={(e) => setT({ ...t, numero: numTarjeta(e.target.value) })} /></Field>
        <div className="form-grid">
          <Field label="Vencimiento"><input className="input" inputMode="numeric" autoComplete="cc-exp" placeholder="MM/AA" value={t.venc} onChange={(e) => setT({ ...t, venc: vencimiento(e.target.value) })} /></Field>
          <Field label="CVV"><input className="input" type="password" inputMode="numeric" autoComplete="cc-csc" value={t.cvv} onChange={(e) => setT({ ...t, cvv: digitos(e.target.value, 4) })} /></Field>
        </div>
        <Field label="Nombre en la tarjeta"><input className="input" autoComplete="cc-name" value={t.nombre} onChange={(e) => setT({ ...t, nombre: letras(e.target.value).toUpperCase() })} /></Field>
        <div className="xs muted">Formulario seguro de la pasarela. Prueba: una tarjeta que termine en 0002 se declina.</div>
        {error && <div className="alert alert-err">{error}</div>}
        <div className="row end">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar <span className="kbd">Esc</span></button>
          <button className="btn btn-primary" disabled={enviando}>{enviando ? 'Procesando…' : `Pagar ${money(total)}`}</button>
        </div>
      </form>
    </Modal>
  )
}

/** Planes de clientes (servicios incluidos) o membresía de prestadores (comisión reducida, prioridad, destacado). */
export function Planes({ para = 'Cliente' }) {
  const prestador = para === 'Prestador'
  const [params] = useSearchParams()
  const planesApi = useApi(`/catalogo/planes?para=${para}`)
  const mias = useApi('/suscripciones/mias')
  const [tarjetaPlan, setTarjetaPlan] = useState(null)
  const [elegido, setElegido] = useState(null)
  const [cancelar, setCancelar] = useState(null)
  const [ocupado, setOcupado] = useState(null)
  const [aviso, setAviso] = useState(params.get('cancelado') ? { tipo: 'warn', texto: 'Cancelaste el pago en PayPal. Tu plan no se activó; puedes intentarlo de nuevo.' } : null)

  const lista = planesApi.data || []
  const vigente = (mias.data || []).find((s) => s.vigente && s.estado === 'Activa') || (mias.data || []).find((s) => s.vigente)
  const sel = lista.find((p) => p.id_plan === elegido && !(vigente?.estado === 'Activa' && vigente.id_plan === p.id_plan)) || null

  const pagarPaypal = async (plan) => {
    setAviso(null)
    setOcupado(plan.id_plan)
    try {
      const r = await post('/suscripciones', { id_plan: plan.id_plan, metodo_pago: 'PayPal' })
      window.location.assign(r.aprobar_url) // página segura de PayPal; vuelve a /pagos/paypal/retorno
    } catch (e) {
      setAviso({ tipo: 'err', texto: e.message })
      setOcupado(null)
    }
  }
  const confirmarCancelacion = async () => {
    const s = cancelar
    setCancelar(null)
    try {
      await post(`/suscripciones/${s.id_suscripcion}/cancelar`)
      setAviso({ tipo: 'ok', texto: `Cancelaste ${s.plan}. Conservas los beneficios hasta el ${dia(s.fecha_renovacion)}.` })
      mias.recargar()
    } catch (e) {
      setAviso({ tipo: 'err', texto: e.message })
    }
  }

  return (
    <Page crumb={prestador ? 'Prestador · Membresía' : 'Inicio · Planes'} title={prestador ? 'Membresía de prestador' : 'Planes de suscripción'}>
      <div className="small muted mb-16">
        {prestador
          ? 'La membresía es opcional: sin ella trabajas con la comisión general. Con un plan pagas menos comisión por servicio, recibes prioridad en la asignación automática y apareces destacado. Pagas el periodo con PayPal o tarjeta y recibes tu factura e-CF.'
          : 'Ahorra con un plan: servicios incluidos cada periodo y descuentos en otros. Pagas el periodo con PayPal o tarjeta y recibes tu factura e-CF.'}
      </div>
      {aviso && <div className={`alert ${{ ok: 'alert-ok', err: 'alert-err', warn: 'alert-warn' }[aviso.tipo]} mb-16`}>{aviso.texto}</div>}
      {planesApi.error && <div className="alert alert-err mb-16">{planesApi.error.message}</div>}

      <div className="grid g-3">
        {lista.map((p, i) => {
          const meses = MESES_PLAN[p.periodicidad] || 1
          const esMio = vigente?.id_plan === p.id_plan
          const actual = esMio && vigente.estado === 'Activa' // el plan activo no se vuelve a comprar
          const marcado = sel?.id_plan === p.id_plan
          return (
            <div key={p.id_plan} role="radio" aria-checked={marcado} tabIndex={actual ? -1 : 0}
              className={`card plan seleccionable ${marcado ? 'elegido' : ''} ${actual ? 'actual' : ''}`}
              onClick={() => !actual && setElegido(p.id_plan)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && !actual && (e.preventDefault(), setElegido(p.id_plan))}>
              <div className="row between">
                <label className="row" style={{ gap: 8, cursor: actual ? 'default' : 'pointer' }}>
                  <input type="radio" name="plan" checked={marcado} disabled={actual} onChange={() => setElegido(p.id_plan)} />
                  <b>{p.nombre}</b>
                </label>
                {esMio ? <Badge color="green">{actual ? 'Plan actual' : 'Tu plan'}</Badge> : i === 1 && lista.length === 3 ? <Badge>Más popular</Badge> : null}
              </div>
              <div className="mt-8"><span className="plan-price">{money0(p.precio_mensual)}</span> <span className="xs muted">/mes + ITBIS</span></div>
              {meses > 1 && <div className="xs muted">Se paga {p.periodicidad.toLowerCase()}: {money0(p.precio_mensual * meses)} + ITBIS</div>}
              {p.descripcion && <div className="small mt-8">{p.descripcion}</div>}
              <ul>{beneficios(p).map((b) => <li key={b}>{b}</li>)}</ul>
              <div className={`btn btn-block ${actual ? 'btn-ghost' : marcado ? 'btn-primary' : 'btn-outline'}`} style={{ pointerEvents: 'none' }}>
                {actual ? '✓ Ya es tu plan' : marcado ? '✓ Seleccionado' : 'Seleccionar'}
              </div>
            </div>
          )
        })}
        {planesApi.cargando && !lista.length && <div className="card muted">Cargando planes…</div>}
      </div>

      {sel && (() => {
        const meses = MESES_PLAN[sel.periodicidad] || 1
        const total = Math.round(Number(sel.precio_mensual) * meses * 1.18 * 100) / 100
        const reemplaza = vigente && vigente.id_plan !== sel.id_plan ? vigente : vigente?.estado === 'Cancelada' ? vigente : null
        return (
          <div className="card mt-16" style={{ border: '2px solid var(--green-700)' }}>
            <div className="row between wrap" style={{ gap: 16 }}>
              <div>
                <div className="card-title" style={{ margin: 0 }}>Plan seleccionado: {sel.nombre}</div>
                <div className="small mt-8">{money(sel.precio_mensual)} × {meses} {meses === 1 ? 'mes' : 'meses'} + ITBIS 18 % = <b>{money(total)}</b></div>
                {reemplaza && <div className="xs muted mt-8">Al pagar, reemplaza tu plan {reemplaza.plan}{reemplaza.estado === 'Cancelada' ? ` (vigente hasta el ${dia(reemplaza.fecha_renovacion)})` : ''}.</div>}
              </div>
              <div className="col" style={{ gap: 8, minWidth: 240 }}>
                <button className="btn btn-paypal btn-block" style={{ fontSize: 13, fontStyle: 'normal' }} disabled={ocupado !== null} onClick={() => pagarPaypal(sel)}>
                  {ocupado === sel.id_plan ? 'Abriendo PayPal…' : <>Pagar con&nbsp;<i>Pay<span>Pal</span></i></>}
                </button>
                <button className="btn btn-outline btn-block" disabled={ocupado !== null} onClick={() => setTarjetaPlan(sel)}>💳 Pagar con tarjeta</button>
              </div>
            </div>
          </div>
        )
      })()}
      {!sel && lista.length > 0 && <div className="small muted mt-12">Selecciona un plan para ver el total y pagar.</div>}
      <div className="xs muted mt-8">PayPal cobra en dólares a la tasa del día; tu factura se emite en pesos dominicanos.</div>

      <div className="card mt-16">
        <div className="card-title">{prestador ? 'Mi membresía' : 'Mi suscripción'}</div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Plan</th><th>Inicio</th><th>Vence / renueva</th><th>Método</th><th>Estado</th><th /></tr></thead>
            <tbody>
              {(mias.data || []).map((s) => (
                <tr key={s.id_suscripcion}>
                  <td className="bold">{s.plan}</td><td>{dia(s.fecha_inicio)}</td><td>{dia(s.fecha_renovacion)}</td>
                  <td>{s.metodo || '—'}{s.referencia ? <div className="xs muted mono">{s.referencia}</div> : null}</td>
                  <td><Badge>{s.estado}</Badge>{s.estado === 'Cancelada' && s.vigente && <div className="xs muted">Beneficios hasta {dia(s.fecha_renovacion)}</div>}</td>
                  <td>{s.estado === 'Activa' && <button className="btn btn-danger btn-sm" onClick={() => setCancelar(s)}>Cancelar suscripción</button>}</td>
                </tr>
              ))}
              {mias.data && !mias.data.length && <tr><td colSpan={6} className="center muted">{prestador ? 'Aún no tienes membresía: trabajas con la comisión general.' : 'Aún no tienes un plan.'}</td></tr>}
            </tbody>
          </table>
        </div>
        {!prestador && vigente?.uso?.length > 0 && (
          <div className="xs muted mt-8">
            Uso del periodo: {vigente.uso.map((u) => (u.cantidad_incluida > 0 ? `${u.nombre} ${Math.min(u.usados, u.cantidad_incluida)}/${u.cantidad_incluida}` : `${u.nombre} −${Number(u.descuento_pct)} %`)).join(' · ')}
          </div>
        )}
      </div>

      {tarjetaPlan && (
        <PagarPlanTarjeta plan={tarjetaPlan} onClose={() => setTarjetaPlan(null)}
          onListo={(texto) => { setTarjetaPlan(null); setAviso({ tipo: 'ok', texto }); mias.recargar() }} />
      )}
      {cancelar && (
        <Modal titulo="Cancelar suscripción" onClose={() => setCancelar(null)}>
          <p className="small">La cancelación será efectiva al final del periodo pagado (<b>{dia(cancelar.fecha_renovacion)}</b>). Hasta entonces conservas los beneficios de {cancelar.plan}.</p>
          <div className="row end mt-16">
            <button className="btn btn-ghost" onClick={() => setCancelar(null)}>Volver <span className="kbd">Esc</span></button>
            <button className="btn btn-danger" onClick={confirmarCancelacion}>Confirmar cancelación</button>
          </div>
        </Modal>
      )}
    </Page>
  )
}

// Planes y suscripciones (administrador, CAT-P05): planes de clientes y membresías de prestadores
const PLAN_VACIO = { nombre: '', descripcion: '', precio_mensual: '', periodicidad: 'Mensual', dirigido_a: 'Cliente', comision_pct: '', prioridad_asignacion: false, destacado: false, servicios: [] }

function EditarPlan({ plan, catalogo, onClose, onListo }) {
  const nuevo = !plan.id_plan
  const [f, setF] = useState({
    ...PLAN_VACIO, ...plan, comision_pct: plan.comision_pct ?? '', prioridad_asignacion: !!plan.prioridad_asignacion, destacado: !!plan.destacado,
    servicios: (plan.servicios || []).map((x) => ({ id_servicio: x.id_servicio, cantidad_incluida: x.cantidad_incluida, descuento_pct: Number(x.descuento_pct) })),
  })
  const [error, setError] = useState(null)
  const [enviando, setEnviando] = useState(false)
  const prestador = f.dirigido_a === 'Prestador'
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const linea = (i, k, v) => setF({ ...f, servicios: f.servicios.map((x, j) => (j === i ? { ...x, [k]: v } : x)) })
  const guardar = async () => {
    setError(null)
    setEnviando(true)
    try {
      const cuerpo = { ...f, precio_mensual: Number(f.precio_mensual), servicios: prestador ? undefined : f.servicios.filter((x) => x.id_servicio) }
      if (nuevo) await post('/catalogo/planes', cuerpo)
      else await put(`/catalogo/planes/${plan.id_plan}`, cuerpo)
      onListo(`Plan ${f.nombre} ${nuevo ? 'creado' : 'actualizado'}.`)
    } catch (e) {
      setError(e)
    } finally {
      setEnviando(false)
    }
  }
  return (
    <Modal titulo={nuevo ? 'Nuevo plan' : `Editar ${plan.nombre}`} onClose={onClose}>
      {nuevo && <Chips valor={f.dirigido_a} onChange={(dirigido_a) => setF({ ...f, dirigido_a })} opciones={[{ value: 'Cliente', label: 'Plan de cliente' }, { value: 'Prestador', label: 'Membresía de prestador' }]} />}
      <div className="form-grid mt-12">
        <Field label="Nombre" req error={error?.detalles?.nombre}><input className="input" maxLength={60} value={f.nombre} onChange={set('nombre')} /></Field>
        <Field label="Precio mensual sin ITBIS (RD$)" req error={error?.detalles?.precio_mensual}><input className="input" inputMode="decimal" value={f.precio_mensual} onChange={(e) => setF({ ...f, precio_mensual: decimal(e.target.value) })} /></Field>
        <Field label="Periodicidad">
          <select className="input" value={f.periodicidad} disabled={!nuevo} onChange={set('periodicidad')}>{Object.keys(MESES_PLAN).map((x) => <option key={x}>{x}</option>)}</select>
        </Field>
        {!nuevo && (
          <Field label="Estado">
            <select className="input" value={f.estado} onChange={set('estado')}><option>Activo</option><option>Inactivo</option></select>
          </Field>
        )}
      </div>
      <Field label="Descripción" className="mt-8"><input className="input" maxLength={200} value={f.descripcion || ''} onChange={set('descripcion')} /></Field>
      {prestador ? (
        <div className="mt-12">
          <Field label="Comisión por servicio (%)" error={error?.detalles?.comision_pct} hint="Vacío = la comisión general de la plataforma">
            <input className="input" inputMode="decimal" value={f.comision_pct} onChange={(e) => setF({ ...f, comision_pct: decimal(e.target.value) })} />
          </Field>
          <label className="row small mt-8" style={{ gap: 8 }}><input type="checkbox" checked={f.prioridad_asignacion} onChange={(e) => setF({ ...f, prioridad_asignacion: e.target.checked })} /> Prioridad en la asignación automática</label>
          <label className="row small mt-8" style={{ gap: 8 }}><input type="checkbox" checked={f.destacado} onChange={(e) => setF({ ...f, destacado: e.target.checked })} /> Destacado en el catálogo</label>
        </div>
      ) : (
        <div className="mt-12">
          <div className="label">Servicios incluidos o con descuento</div>
          {f.servicios.map((x, i) => (
            <div key={i} className="row mt-8" style={{ gap: 8 }}>
              <select className="input grow" value={x.id_servicio || ''} onChange={(e) => linea(i, 'id_servicio', Number(e.target.value))}>
                <option value="">Servicio…</option>
                {catalogo.map((c) => <option key={c.id_servicio} value={c.id_servicio}>{c.nombre}</option>)}
              </select>
              <input className="input" style={{ width: 90 }} inputMode="numeric" title="Usos incluidos por periodo" placeholder="Incl." value={x.cantidad_incluida} onChange={(e) => linea(i, 'cantidad_incluida', entero(e.target.value))} />
              <input className="input" style={{ width: 90 }} inputMode="decimal" title="Descuento % sobre lo que exceda" placeholder="Desc. %" value={x.descuento_pct} onChange={(e) => linea(i, 'descuento_pct', decimal(e.target.value))} />
              <button className="btn btn-ghost btn-sm" onClick={() => setF({ ...f, servicios: f.servicios.filter((_, j) => j !== i) })}>✕</button>
            </div>
          ))}
          <button className="btn btn-outline btn-sm mt-8" onClick={() => setF({ ...f, servicios: [...f.servicios, { id_servicio: null, cantidad_incluida: 0, descuento_pct: 0 }] })}>＋ Agregar servicio</button>
        </div>
      )}
      {error && !error.detalles && <div className="alert alert-err mt-12">{error.message}</div>}
      <div className="row end mt-16">
        <button className="btn btn-ghost" onClick={onClose}>Cancelar <span className="kbd">Esc</span></button>
        <button className="btn btn-primary" disabled={enviando || !f.nombre.trim() || !(Number(f.precio_mensual) > 0)} onClick={guardar}>{enviando ? 'Guardando…' : 'Guardar'}</button>
      </div>
    </Modal>
  )
}

export function PlanesAdmin() {
  const planesApi = useApi('/catalogo/planes?para=Todos')
  const subs = useApi('/admin/suscripciones')
  const catalogo = useApi('/catalogo/servicios')
  const [editar, setEditar] = useState(null)
  const [aviso, setAviso] = useState(null)
  const [filtro, setFiltro] = useState('Todos')
  const lista = planesApi.data || []
  const grupo = (dirigido, titulo) => {
    const ps = lista.filter((p) => p.dirigido_a === dirigido)
    return (
      <>
        <div className="card-title mt-16">{titulo}</div>
        <div className="grid g-3 mb-16">
          {ps.map((p) => (
            <div key={p.id_plan} className="card plan">
              <div className="row between"><b>{p.nombre}</b><Badge>{p.estado}</Badge></div>
              <div className="plan-price mt-8">{money0(p.precio_mensual)} <span className="xs muted">/mes + ITBIS · {p.periodicidad.toLowerCase()}</span></div>
              {p.descripcion && <div className="small mt-8">{p.descripcion}</div>}
              <ul>{beneficios(p).map((b) => <li key={b}>{b}</li>)}</ul>
              <button className="btn btn-outline btn-sm" onClick={() => setEditar(p)}>✏️ Editar</button>
            </div>
          ))}
          {!ps.length && <div className="card muted small">{planesApi.cargando ? 'Cargando…' : 'No hay planes.'}</div>}
        </div>
      </>
    )
  }
  const filas = (subs.data || []).filter((x) => filtro === 'Todos' || x.dirigido_a === filtro)
  return (
    <Page crumb="Administración · Planes" title="Planes y suscripciones">
      <div className="row between mb-12">
        <div className="small muted">Planes de clientes (servicios incluidos y descuentos) y membresías de prestadores (comisión reducida, prioridad y destacado).</div>
        <button className="btn btn-primary btn-sm" onClick={() => setEditar({})}>＋ Nuevo plan</button>
      </div>
      {aviso && <div className="alert alert-ok mb-12">{aviso}</div>}
      {planesApi.error && <div className="alert alert-err mb-12">{planesApi.error.message}</div>}
      {grupo('Cliente', 'Planes de clientes')}
      {grupo('Prestador', 'Membresías de prestadores')}
      <div className="card">
        <div className="row between mb-12">
          <div className="card-title" style={{ margin: 0 }}>Suscripciones</div>
          <Chips valor={filtro} onChange={setFiltro} opciones={[{ value: 'Todos', label: 'Todas' }, { value: 'Cliente', label: 'Clientes' }, { value: 'Prestador', label: 'Prestadores' }]} />
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Suscriptor</th><th>Tipo</th><th>Plan</th><th>Inicio</th><th>Renovación</th><th>Estado</th></tr></thead>
            <tbody>
              {filas.map((x) => (
                <tr key={x.id_suscripcion}>
                  <td>{x.cliente}</td><td>{x.dirigido_a === 'Prestador' ? 'Prestador' : 'Cliente'}</td><td className="semibold">{x.plan}</td>
                  <td>{dia(x.fecha_inicio)}</td><td>{dia(x.fecha_renovacion)}</td><td><Badge>{x.estado}</Badge></td>
                </tr>
              ))}
              {!filas.length && <tr><td colSpan={6} className="center muted">{subs.cargando ? 'Cargando…' : 'No hay suscripciones.'}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {editar && (
        <EditarPlan plan={editar} catalogo={catalogo.data?.servicios || catalogo.data || []} onClose={() => setEditar(null)}
          onListo={(texto) => { setEditar(null); setAviso(texto); planesApi.recargar() }} />
      )}
    </Page>
  )
}
