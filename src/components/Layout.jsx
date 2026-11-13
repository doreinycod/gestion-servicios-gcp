import { useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate, Navigate, useOutletContext, useLocation } from 'react-router-dom'
import { useSession, INICIO_POR_ROL } from './session'
import { Avatar } from './ui'
import { useApi } from '../lib/useApi'
import { post } from '../lib/api'
import { hace } from '../lib/format'

// Menús por rol (sección 16.3 – Mapa de navegación por rol)
const MENUS = {
  Cliente: {
    titulo: 'Cliente',
    items: [
      { to: '/catalogo', icon: '🏠', label: 'Inicio / Catálogo' },
      { to: '/solicitudes/nueva', icon: '＋', label: 'Nueva solicitud' },
      { to: '/mis-solicitudes', icon: '📋', label: 'Mis solicitudes', ayuda: 'solicitudes esperan una acción tuya (pagar, confirmar o responder un cargo)' },
      { to: '/pagos', icon: '💳', label: 'Pagos' },
      { to: '/mis-facturas', icon: '📄', label: 'Mis facturas' },
      { to: '/planes', icon: '⭐', label: 'Planes' },
      { to: '/asistente', icon: '🤖', label: 'Asistente IA' },
      { to: '/perfil', icon: '👤', label: 'Mi perfil' },
    ],
  },
  Empleado: {
    titulo: 'Prestador',
    items: [
      { to: '/prestador', icon: '📊', label: 'Mi panel', end: true },
      { to: '/prestador/asignaciones', icon: '🗂️', label: 'Asignaciones', ayuda: 'asignaciones por aceptar o rechazar' },
      { to: '/prestador/agenda', icon: '📅', label: 'Agenda' },
      { to: '/prestador/cobros', icon: '💵', label: 'Cobros en efectivo' },
      { to: '/prestador/ganancias', icon: '💰', label: 'Mis ganancias' },
      { to: '/prestador/membresia', icon: '⭐', label: 'Membresía' },
      { to: '/prestador/facturas', icon: '📄', label: 'Mis facturas' },
      { to: '/prestador/calificaciones', icon: '⭐', label: 'Calificaciones' },
      { to: '/prestador/perfil', icon: '👤', label: 'Mi perfil y disponibilidad' },
    ],
  },
  Administrador: {
    titulo: 'Administración',
    items: [
      { to: '/admin', icon: '📊', label: 'Dashboard', end: true },
      { to: '/admin/catalogo', icon: '🗃️', label: 'Catálogo y servicios' },
      { to: '/admin/prestadores', icon: '🧰', label: 'Prestadores', ayuda: 'prestadores pendientes de aprobación' },
      { to: '/admin/solicitudes', icon: '📋', label: 'Solicitudes', ayuda: 'solicitudes sin prestador asignado' },
      { to: '/admin/pagos', icon: '💳', label: 'Conciliación de pagos', ayuda: 'pagos en verificación' },
      { to: '/admin/cuentas-prestadores', icon: '💰', label: 'Cuentas de prestadores' },
      { to: '/admin/facturacion', icon: '📄', label: 'Facturación e-CF', ayuda: 'pendientes: solicitudes de nota de crédito, e-CF rechazados o sin emitir' },
      { to: '/admin/planes', icon: '⭐', label: 'Planes y suscripciones' },
      { to: '/admin/asistente', icon: '🤖', label: 'Asistente IA' },
      { to: '/admin/usuarios', icon: '👥', label: 'Usuarios y roles' },
      { to: '/admin/reportes', icon: '📈', label: 'Reportes' },
      { to: '/admin/configuracion', icon: '⚙️', label: 'Configuración' },
    ],
  },
}

const ICONO_NOTIF = { Solicitud: '🛠️', Pago: '💳', Factura: '📄', Sistema: '🔔' }

export function Brand() {
  return (
    <div className="brand">
      <div className="brand-logo">DS</div>
      <div>
        <div className="brand-name">Directorio</div>
        <div className="brand-sub">Servicios, SRL</div>
      </div>
    </div>
  )
}

/** Layout protegido: exige sesión y que el rol coincida con el área. */
export default function Layout({ rol }) {
  const { rol: activo, cerrar } = useSession()
  const [abierto, setAbierto] = useState(false)
  const navigate = useNavigate()
  const { pathname } = useLocation()
  // Contadores reales de pendientes por opción del menú (se actualizan al cambiar de pantalla y cada minuto)
  const contadores = useApi(activo && activo === rol ? '/menu/contadores' : null)
  const recargarContadores = contadores.recargar
  useEffect(() => { recargarContadores() }, [pathname, recargarContadores])
  useEffect(() => {
    const t = setInterval(recargarContadores, 60_000)
    return () => clearInterval(t)
  }, [recargarContadores])
  if (!activo) return <Navigate to="/login" replace />
  if (activo !== rol) return <Navigate to={INICIO_POR_ROL[activo]} replace />
  const menu = MENUS[rol]

  return (
    <div className="app">
      <aside className={`sidebar ${abierto ? 'open' : ''}`}>
        <Brand />
        <div className="nav-section">{menu.titulo}</div>
        {menu.items.map((it) => (
          <NavLink key={it.to} to={it.to} end={it.end} title={contadores.data?.[it.to] > 0 ? `${contadores.data[it.to]} ${it.ayuda}` : undefined} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`} onClick={() => setAbierto(false)}>
            <span className="nav-icon">{it.icon}</span>
            {it.label}
            {contadores.data?.[it.to] > 0 && <span className="nav-badge" title={`${contadores.data[it.to]} ${it.ayuda}`}>{contadores.data[it.to]}</span>}
          </NavLink>
        ))}
        <div className="nav-section">Sesión</div>
        <button className="nav-item" onClick={() => { cerrar(); navigate('/login') }}>
          <span className="nav-icon">🚪</span>Cerrar sesión
        </button>
      </aside>
      <div className={`backdrop ${abierto ? 'open' : ''}`} onClick={() => setAbierto(false)} />
      <div className="main">
        <Outlet context={{ abrirMenu: () => setAbierto(true) }} />
      </div>
    </div>
  )
}

/** Barra superior + área de trabajo de cada pantalla. */
export function Page({ crumb, title, children }) {
  const { usuario } = useSession()
  const [notif, setNotif] = useState(false)
  const notifs = useApi('/notificaciones')
  // Marcadas como leídas en esta pantalla (se ven al instante, sin esperar la recarga)
  const [leidas, setLeidas] = useState({ todas: false, ids: [] })
  const [errorNotif, setErrorNotif] = useState('')
  const esLeida = (n) => n.leida || leidas.todas || leidas.ids.includes(n.id_notificacion)
  const lista = notifs.data?.items || []
  const pendientes = leidas.todas ? 0 : Math.max((notifs.data?.no_leidas || 0) - lista.filter((n) => !n.leida && leidas.ids.includes(n.id_notificacion)).length, 0)
  const leerTodas = async () => {
    setErrorNotif('')
    setLeidas({ todas: true, ids: [] })
    try { await post('/notificaciones/leer-todas'); notifs.recargar() } catch (e) { setLeidas({ todas: false, ids: [] }); setErrorNotif(e.message) }
  }
  const leerUna = async (n) => {
    if (esLeida(n)) return
    setLeidas((l) => ({ ...l, ids: [...l.ids, n.id_notificacion] }))
    try { await post(`/notificaciones/${n.id_notificacion}/leer`) } catch { /* se reintenta al marcar todas */ }
  }
  const alternar = () => {
    if (!notif) { notifs.recargar(); setLeidas({ todas: false, ids: [] }) }
    setNotif(!notif)
  }
  const { abrirMenu } = useOutletContext() || {}

  return (
    <>
      <header className="topbar">
        <button className="hamburger" onClick={abrirMenu} aria-label="Abrir menú">☰</button>
        <div className="topbar-title">
          <div className="crumb">{crumb}</div>
          <div className="page-title">{title}</div>
        </div>
        <div style={{ position: 'relative', marginLeft: 'auto' }}>
          <button className="bell" onClick={alternar} aria-label="Notificaciones">
            🔔{pendientes > 0 && <span className="bell-count">{pendientes}</span>}
          </button>
          {notif && <div className="dropdown-fondo" onClick={() => setNotif(false)} />}
          {notif && (
            <div className="dropdown">
              <div className="row between" style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
                <span className="bold">Notificaciones{pendientes > 0 && <span className="xs muted"> · {pendientes} sin leer</span>}</span>
                {pendientes > 0
                  ? <button className="link-btn small" onClick={leerTodas}>Marcar todo como leído</button>
                  : <span className="xs muted">✓ Todo leído</span>}
              </div>
              {errorNotif && <div className="alert alert-err xs" style={{ margin: 8 }}>{errorNotif}</div>}
              <div style={{ maxHeight: 380, overflowY: 'auto' }}>
                {lista.map((n) => (
                  <div key={n.id_notificacion} className={`notif ${esLeida(n) ? '' : 'unread'}`} onClick={() => leerUna(n)} title={esLeida(n) ? '' : 'Marcar como leída'}>
                    <span>{ICONO_NOTIF[n.tipo] || '🔔'}</span>
                    <div className="grow">
                      <div className="semibold">{n.titulo}</div>
                      <div className="xs muted">{n.mensaje}</div>
                      <div className="xs muted">{hace(n.fecha_creacion)}</div>
                    </div>
                    {!esLeida(n) && <span className="notif-dot" />}
                  </div>
                ))}
                {!lista.length && <div className="small muted center" style={{ padding: 16 }}>{notifs.cargando ? 'Cargando…' : 'No tienes notificaciones.'}</div>}
              </div>
            </div>
          )}
        </div>
        <div className="user-chip">
          <Avatar ini={usuario.ini} light size="sm" />
          <div className="user-text">
            <div className="user-name">{usuario.nombreCorto}</div>
            <div className="user-role">{usuario.sub}</div>
          </div>
        </div>
      </header>
      <main className="content">{children}</main>
    </>
  )
}
