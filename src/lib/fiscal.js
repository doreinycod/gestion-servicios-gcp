// Reglas fiscales y de validación (secciones 16.5.5, 23.4 y 29 del diseño)

export const ITBIS = 0.18

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100

/** Cédula dominicana: 11 dígitos, dígito verificador por módulo 10 (pesos 1-2). */
export function cedulaValida(valor = '') {
  const d = valor.replace(/\D/g, '')
  if (d.length !== 11) return false
  let suma = 0
  for (let i = 0; i < 10; i++) {
    let p = Number(d[i]) * (i % 2 === 0 ? 1 : 2)
    if (p > 9) p -= 9
    suma += p
  }
  return (10 - (suma % 10)) % 10 === Number(d[10])
}

/** RNC: 9 dígitos, dígito verificador por módulo 11 (pesos 7 9 8 6 5 4 3 2). */
export function rncValido(valor = '') {
  const d = valor.replace(/\D/g, '')
  if (d.length !== 9) return false
  const pesos = [7, 9, 8, 6, 5, 4, 3, 2]
  const suma = pesos.reduce((s, p, i) => s + p * Number(d[i]), 0)
  const r = suma % 11
  const dv = r === 0 ? 2 : r === 1 ? 1 : 11 - r
  return dv === Number(d[8])
}

export const emailValido = (v = '') => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) && v.length <= 120
export const telefonoValido = (v = '') => /^(809|829|849)\d{7}$/.test(v.replace(/\D/g, ''))
export const contrasenaValida = (v = '') => v.length >= 8 && /[A-Z]/.test(v) && /\d/.test(v)

export function fortaleza(v = '') {
  let p = 0
  if (v.length >= 8) p++
  if (/[A-Z]/.test(v)) p++
  if (/\d/.test(v)) p++
  if (/[^A-Za-z0-9]/.test(v) || v.length >= 12) p++
  return ['Muy débil', 'Débil', 'Regular', 'Buena', 'Fuerte'][p]
}

/**
 * Calcula los totales de un conjunto de líneas.
 * Cada línea: { cantidad, precio_unitario, subtotal, aplica_itbis, descuento_pct }
 * El descuento de plan se aplica al precio unitario (precio_neto), de modo que
 * total_linea = cantidad × precio_neto + itbis_linea y total = subtotal − descuento + ITBIS.
 */
export function calcularTotales(lineas) {
  let subtotal = 0, descuento = 0, itbis = 0
  const detalle = lineas.map((l) => {
    const cant = Number(l.cantidad) || 1
    const sub = round2(l.subtotal ?? cant * l.precio_unitario)
    const pu = round2(l.precio_unitario ?? sub / cant)
    const puNeto = round2(pu * (1 - (l.descuento_pct || 0) / 100))
    const neto = round2(puNeto * cant)
    const desc = round2(sub - neto)
    const itbisLinea = l.aplica_itbis ? round2(neto * ITBIS) : 0
    subtotal += sub
    descuento += desc
    itbis += itbisLinea
    return { ...l, cantidad: cant, precio_neto: puNeto, descuento_linea: desc, itbis_linea: itbisLinea, total_linea: round2(neto + itbisLinea) }
  })
  subtotal = round2(subtotal)
  descuento = round2(descuento)
  itbis = round2(itbis)
  return { detalle, subtotal, descuento, itbis, total: round2(subtotal - descuento + itbis) }
}

/** e31 si es Empresa con RNC válido; e32 en cualquier otro caso. */
export const tipoEcf = (cliente) =>
  cliente?.tipo_cliente === 'Empresa' && rncValido(cliente.rnc_cedula) ? 'e31' : 'e32'

/** e-NCF: E + tipo (31/32) + secuencia de 10 dígitos. */
export const formatoNcf = (tipo, numero) => `E${tipo.slice(1)}${String(numero).padStart(10, '0')}`

const ALFANUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export function codigoAleatorio(n = 6) {
  let s = ''
  for (let i = 0; i < n; i++) s += ALFANUM[Math.floor(Math.random() * ALFANUM.length)]
  return s
}

export const codigoSeguridad = () => {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  let s = ''
  for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)]
  return s
}
