// Formatos de presentación (moneda RD$, fechas dd/mm/aaaa, horas 12 h)

const nf = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

export const num = (n) => nf.format(Number(n) || 0)
export const num0 = (n) => nf0.format(Number(n) || 0)
export const money = (n) => `RD$ ${num(n)}`
export const money0 = (n) => `RD$ ${num0(n)}`
export const usd = (n) => `US$ ${num(n)}`

const pad = (n) => String(n).padStart(2, '0')

export function fecha(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`
}

export function fechaCorta(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`
}

export function hora(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  let h = d.getHours()
  const ap = h >= 12 ? 'p. m.' : 'a. m.'
  h = h % 12 || 12
  return `${h}:${pad(d.getMinutes())} ${ap}`
}

export function hora12(hhmm) {
  if (!hhmm) return ''
  const [h, m] = hhmm.split(':').map(Number)
  const ap = h >= 12 ? 'p. m.' : 'a. m.'
  return `${h % 12 || 12}:${pad(m)} ${ap}`
}

export const fechaHora = (iso) => (iso ? `${fecha(iso)} · ${hora(iso)}` : '—')

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']
const DIAS_CORTOS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']
export const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
export const MESES_CORTOS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']

export const diaSemana = (iso) => DIAS[new Date(iso).getDay()]
export const diaCorto = (iso) => DIAS_CORTOS[new Date(iso).getDay()]

/** Fecha local (yyyy-mm-dd) de un Date, sin desfase por zona horaria. */
export function isoDia(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Combina fecha (yyyy-mm-dd) y hora (hh:mm) en ISO local. */
export function combinar(dia, hhmm = '00:00') {
  return new Date(`${dia}T${hhmm}:00`).toISOString()
}

export function hace(iso) {
  const min = Math.round((Date.now() - new Date(iso)) / 60000)
  if (min < 1) return 'hace un momento'
  if (min < 60) return `hace ${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `hace ${h} h`
  const d = Math.round(h / 24)
  if (d < 7) return `hace ${d} ${d === 1 ? 'día' : 'días'}`
  const s = Math.round(d / 7)
  if (d < 30) return `hace ${s} ${s === 1 ? 'semana' : 'semanas'}`
  const m = Math.round(d / 30)
  return `hace ${m} ${m === 1 ? 'mes' : 'meses'}`
}

export const iniciales = (nombre = '', apellido = '') =>
  `${nombre.trim()[0] || ''}${(apellido.trim() || nombre.trim().split(' ')[1] || '')[0] || ''}`.toUpperCase()

export function formatoCedula(v = '') {
  const d = v.replace(/\D/g, '')
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 10)}-${d.slice(10)}`
  if (d.length === 9) return `${d.slice(0, 1)}-${d.slice(1, 3)}-${d.slice(3, 8)}-${d.slice(8)}`
  return v
}

export const stars = (n) => '★★★★★'.slice(0, Math.round(n)) + '☆☆☆☆☆'.slice(0, 5 - Math.round(n))

/** Fecha sin hora 'yyyy-mm-dd' (columnas DATE) → dd/mm/aaaa, sin desfase de zona horaria. */
export const dia = (s) => (s ? String(s).slice(0, 10).split('-').reverse().join('/') : '—')

/** Día de la semana de una fecha 'yyyy-mm-dd'. */
export const diaDeFecha = (s) => (s ? DIAS[new Date(`${String(s).slice(0, 10)}T12:00:00`).getDay()] : '')

/** Fecha de mañana en formato yyyy-mm-dd (fecha preferida por defecto). */
export const manana = () => isoDia(new Date(Date.now() + 864e5))

/** Tiempo restante hasta `iso` como "h:mm h" (plazo de 2 h para responder una asignación). */
export function restante(iso) {
  const min = Math.max(Math.round((new Date(iso) - Date.now()) / 60000), 0)
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')} h`
}
