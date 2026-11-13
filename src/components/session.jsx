import { createContext, useContext, useEffect, useState } from 'react'
import { leerSesion, guardarSesion } from '../lib/api'

// Sesión real: token JWT + perfil del usuario (v_usuarioActivo / v_rolActivo) devueltos por /api/auth/login.

// eslint-disable-next-line react-refresh/only-export-components
export const INICIO_POR_ROL = { Cliente: '/catalogo', Empleado: '/prestador', Administrador: '/admin' }

// Cuentas de demostración creadas por `npm run db:seed` (contraseña Demo1234)
// eslint-disable-next-line react-refresh/only-export-components
export const CUENTAS_DEMO = {
  Cliente: 'maria.rodriguez@gmail.com',
  Empleado: 'cmendez.electric@gmail.com',
  Administrador: 'ana.diaz@directorioservicios.do',
}

const SUBTITULO = {
  Cliente: (u) => `Cliente · ${u.tipo_cliente || 'Persona física'}`,
  Empleado: (u) => `Prestador · ${u.especialidad || ''}`.replace(/ · $/, ''),
  Administrador: () => 'Administrador',
}

function presentar(u) {
  if (!u) return null
  const nombre = u.tipo_cliente === 'Empresa' && u.razon_social ? u.razon_social : `${u.nombre.split(' ')[0]} ${(u.apellido || '').split(' ')[0]}`.trim()
  const ini = nombre.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase()
  return { ...u, nombreCorto: nombre, ini, sub: SUBTITULO[u.rol]?.(u) || u.rol, inicio: INICIO_POR_ROL[u.rol] }
}

const SessionCtx = createContext(null)

export function SessionProvider({ children }) {
  const [sesion, setSesion] = useState(leerSesion)

  useEffect(() => {
    const expirar = () => setSesion(null)
    window.addEventListener('sesion-expirada', expirar)
    return () => window.removeEventListener('sesion-expirada', expirar)
  }, [])

  /** Guarda el token y el perfil devueltos por /auth/login o /auth/registro. */
  const iniciar = ({ token, usuario }) => {
    const s = { token, usuario }
    guardarSesion(s)
    setSesion(s)
  }
  const actualizarUsuario = (usuario) => {
    const s = { ...sesion, usuario }
    guardarSesion(s)
    setSesion(s)
  }
  const cerrar = () => {
    guardarSesion(null)
    setSesion(null)
  }

  const usuario = presentar(sesion?.usuario)
  return (
    <SessionCtx.Provider value={{ rol: usuario?.rol || null, usuario, iniciar, cerrar, actualizarUsuario }}>
      {children}
    </SessionCtx.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export const useSession = () => useContext(SessionCtx)
