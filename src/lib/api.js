// Cliente de la API del backend (/api, redirigido por Vite a http://127.0.0.1:3000)
const CLAVE = 'gs_sesion'

export function leerSesion() {
  try {
    return JSON.parse(localStorage.getItem(CLAVE)) || null
  } catch {
    return null
  }
}

export function guardarSesion(s) {
  try {
    if (s) localStorage.setItem(CLAVE, JSON.stringify(s))
    else localStorage.removeItem(CLAVE)
  } catch { /* sin almacenamiento disponible */ }
}

export class ApiError extends Error {
  constructor(status, mensaje, detalles) {
    super(mensaje)
    this.status = status
    this.detalles = detalles
  }
}

/** Llama a la API. `cuerpo` puede ser un objeto (JSON) o un FormData. */
export async function api(ruta, { metodo = 'GET', cuerpo } = {}) {
  const headers = {}
  const token = leerSesion()?.token
  if (token) headers.Authorization = `Bearer ${token}`
  let body
  if (cuerpo instanceof FormData) body = cuerpo
  else if (cuerpo !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(cuerpo)
  }
  let r
  try {
    r = await fetch(`/api${ruta}`, { method: metodo, headers, body })
  } catch {
    throw new ApiError(0, 'No hay conexión con el servidor. Verifique que la API esté encendida.')
  }
  const texto = await r.text()
  let data
  try { data = texto ? JSON.parse(texto) : null } catch { data = texto }
  if (r.status === 401 && token) {
    guardarSesion(null)
    window.dispatchEvent(new Event('sesion-expirada'))
  }
  if (!r.ok) throw new ApiError(r.status, data?.error || `Error ${r.status}`, data?.detalles)
  return data
}

export const get = (ruta) => api(ruta)
export const post = (ruta, cuerpo) => api(ruta, { metodo: 'POST', cuerpo })
export const put = (ruta, cuerpo) => api(ruta, { metodo: 'PUT', cuerpo })
export const patch = (ruta, cuerpo) => api(ruta, { metodo: 'PATCH', cuerpo })
