// Filtros de entrada: limpian lo que el usuario escribe o pega según el tipo de campo.
// Se usan en el onChange de los campos controlados: onChange={(e) => setNombre(letras(e.target.value))}
// y, en los campos no controlados, con el atajo onInput={soloLetras}.

/** Letras (con acentos, ñ y ü), espacios y los signos de un nombre: ' - . */
export const letras = (v = '') => v.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s'.-]/g, '').replace(/\s{2,}/g, ' ')

/** Texto sin números: como letras, más / , ( ) para especialidades u ocupaciones (ej. "Técnico de A/A"). */
export const textoSinNumeros = (v = '') => v.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s'.,/()-]/g, '').replace(/\s{2,}/g, ' ')

/** Solo dígitos, con un máximo opcional de caracteres. */
export const digitos = (v = '', max = 20) => String(v).replace(/\D/g, '').slice(0, max)

/** Número entero sin ceros a la izquierda (cantidades, años, minutos). */
export const entero = (v = '', max = 9) => digitos(v, max).replace(/^0+(?=\d)/, '')

/** Monto con hasta `dec` decimales: solo dígitos y un punto (las comas de miles se quitan). */
export function decimal(v = '', dec = 2) {
  const limpio = String(v).replace(/,/g, '').replace(/[^\d.]/g, '')
  const [ent, ...resto] = limpio.split('.')
  if (!resto.length) return ent.slice(0, 10)
  return `${ent.slice(0, 10)}.${resto.join('').slice(0, dec)}`
}

/** Cédula dominicana: 11 dígitos con formato 000-0000000-0. */
export function cedula(v = '') {
  const d = digitos(v, 11)
  if (d.length <= 3) return d
  if (d.length <= 10) return `${d.slice(0, 3)}-${d.slice(3)}`
  return `${d.slice(0, 3)}-${d.slice(3, 10)}-${d.slice(10)}`
}

/** RNC (9 dígitos, 1-32-45678-5) o cédula (11 dígitos) en el mismo campo. */
export function rncCedula(v = '') {
  const d = digitos(v, 11)
  if (d.length > 9) return cedula(d)
  if (d.length <= 1) return d
  if (d.length <= 3) return `${d[0]}-${d.slice(1)}`
  if (d.length <= 8) return `${d[0]}-${d.slice(1, 3)}-${d.slice(3)}`
  return `${d[0]}-${d.slice(1, 3)}-${d.slice(3, 8)}-${d.slice(8)}`
}

/** Teléfono dominicano: 10 dígitos con formato 809-555-0000. */
export function telefono(v = '') {
  const d = digitos(v, 10)
  if (d.length <= 3) return d
  if (d.length <= 6) return `${d.slice(0, 3)}-${d.slice(3)}`
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`
}

/** Número de tarjeta en grupos de 4 (hasta 19 dígitos). */
export const tarjeta = (v = '') => digitos(v, 19).replace(/(\d{4})(?=\d)/g, '$1 ')

/** Vencimiento de tarjeta MM/AA (mes 01–12). */
export function vencimiento(v = '') {
  let d = digitos(v, 4)
  if (d.length === 1 && d > '1') d = `0${d}`
  if (d.length >= 2 && (d.slice(0, 2) === '00' || d.slice(0, 2) > '12')) d = d.slice(0, 1)
  return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d
}

/** Referencia o número de comprobante: letras, dígitos y guiones, en mayúsculas. */
export const referencia = (v = '', max = 60) => v.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, max)

/** Atajos para campos no controlados (defaultValue): onInput={soloLetras} */
const aplicar = (fn) => (e) => { const t = e.currentTarget; const nuevo = fn(t.value); if (nuevo !== t.value) t.value = nuevo }
export const soloLetras = aplicar(letras)
export const soloTextoSinNumeros = aplicar(textoSinNumeros)
export const soloEntero = aplicar((v) => entero(v))
export const soloDecimal = aplicar((v) => decimal(v))
export const soloTelefono = aplicar(telefono)
export const soloRncCedula = aplicar(rncCedula)

/** Nombre válido: al menos 2 letras y sin números (misma regla que el servidor). */
export const nombreValido = (v = '') => /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s'.-]*$/.test(v.trim()) && v.trim().length >= 2
