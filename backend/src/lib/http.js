// Errores HTTP con mensaje para el usuario (sección 29: mensajes de validación)
export class HttpError extends Error {
  constructor(status, message, detalles) {
    super(message)
    this.status = status
    this.detalles = detalles
  }
}

export const badRequest = (msg, detalles) => new HttpError(400, msg, detalles)
export const notFound = (msg = 'Recurso no encontrado') => new HttpError(404, msg)
export const forbidden = (msg = 'No tiene permiso para esta acción') => new HttpError(403, msg)
export const conflict = (msg) => new HttpError(409, msg)

/** Lanza 400 con todos los errores de campo si hay alguno. */
export function validar(errores) {
  const malos = Object.fromEntries(Object.entries(errores).filter(([, v]) => v))
  if (Object.keys(malos).length) throw badRequest(Object.values(malos)[0], malos)
}

export const pad = (n, len) => String(n).padStart(len, '0')
