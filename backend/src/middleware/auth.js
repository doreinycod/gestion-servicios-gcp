import jwt from 'jsonwebtoken'
import { one } from '../config/db.js'
import { HttpError } from '../lib/http.js'

const SECRET = process.env.JWT_SECRET || 'dev-secret'
const EXPIRES = process.env.JWT_EXPIRES || '30m'

export const firmarToken = (u) =>
  jwt.sign({ sub: u.id_usuario, rol: u.nombre_rol }, SECRET, { expiresIn: EXPIRES })

/**
 * Carga v_usuarioActivo / v_rolActivo desde el token JWT (sección 16.1).
 * Agrega req.usuario con id_cliente / id_empleado según el rol.
 */
export async function autenticar(req, _res, next) {
  const h = req.headers.authorization || ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : null
  if (!token) return next(new HttpError(401, 'Debe iniciar sesión'))
  let payload
  try {
    payload = jwt.verify(token, SECRET)
  } catch {
    return next(new HttpError(401, 'La sesión expiró, inicie sesión nuevamente'))
  }
  const u = await one(
    `SELECT u.id_usuario, u.nombre, u.apellido, u.email, u.estado, r.nombre_rol,
            c.id_cliente, c.tipo_cliente, e.id_empleado
       FROM usuarios u
       JOIN roles r ON r.id_rol = u.id_rol
       LEFT JOIN clientes c ON c.id_usuario = u.id_usuario
       LEFT JOIN empleados e ON e.id_usuario = u.id_usuario
      WHERE u.id_usuario = ?`,
    [payload.sub],
  )
  if (!u || u.estado !== 'Activo') return next(new HttpError(401, 'La cuenta no está activa'))
  req.usuario = u
  next()
}

/** Autenticación opcional: si hay token lo carga, si no continúa como visitante. */
export async function autenticarOpcional(req, res, next) {
  if (!req.headers.authorization) return next()
  return autenticar(req, res, next)
}

/** Restringe la ruta a uno o varios roles (matriz de acceso, sección 25.2). */
export const soloRol = (...roles) => (req, _res, next) => {
  if (!req.usuario || !roles.includes(req.usuario.nombre_rol)) {
    return next(new HttpError(403, 'No tiene permiso para esta acción'))
  }
  next()
}
