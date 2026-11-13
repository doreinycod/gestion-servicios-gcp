import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

const COLORES = {
  Publicado: 'green', Activo: 'green', Activa: 'green', Aprobado: 'green', Confirmado: 'green', Completado: 'green',
  Aceptado: 'green', Aceptada: 'green', Verificado: 'green', Vigente: 'green', Disponible: 'green', Emitida: 'green', Completada: 'green',
  Pendiente: 'yellow', Borrador: 'yellow', Revisar: 'yellow', Asignada: 'yellow', 'Aceptado condicional': 'orange',
  'En proceso': 'blue', 'En verificación': 'purple',
  Cancelado: 'red', Rechazado: 'red', Rechazada: 'red', Inactivo: 'red', Bloqueado: 'red', Declinado: 'red', Anulada: 'red',
  Ocupado: 'red', Cerrada: 'gray', Abierta: 'blue',
}

export function Badge({ children, color }) {
  const c = color || COLORES[children] || 'gray'
  return <span className={`badge b-${c}`}>{children}</span>
}

export function Avatar({ ini, size = '', light = false }) {
  return <div className={`avatar ${size} ${light ? 'light' : ''}`}>{ini}</div>
}

export function Stepper({ pasos, actual }) {
  return (
    <div className="stepper">
      {pasos.map((p, i) => (
        <div key={p} style={{ display: 'contents' }}>
          <div className={`step ${i < actual ? 'done' : ''} ${i === actual ? 'current' : ''}`}>
            <div className="step-dot">{i < actual ? '✓' : i + 1}</div>
            <span>{p}</span>
          </div>
          {i < pasos.length - 1 && <div className="step-line" />}
        </div>
      ))}
    </div>
  )
}

export function Modal({ titulo, onClose, children, ancho }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" style={ancho ? { maxWidth: ancho } : undefined} onClick={(e) => e.stopPropagation()}>
        {titulo && <div className="modal-title">{titulo}</div>}
        {children}
      </div>
    </div>
  )
}

export function Kpi({ label, value, foot, up, color }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value" style={color ? { color } : undefined}>{value}</div>
      {foot && <div className={`kpi-foot ${up ? 'up' : ''}`}>{foot}</div>}
    </div>
  )
}

export function Chips({ opciones, valor, onChange }) {
  return (
    <div className="row wrap">
      {opciones.map((o) => {
        const v = typeof o === 'string' ? o : o.value
        const l = typeof o === 'string' ? o : o.label
        return (
          <button key={v} type="button" className={`chip ${valor === v ? 'active' : ''}`} onClick={() => onChange(v)}>
            {l}
          </button>
        )
      })}
    </div>
  )
}

export function Stars({ n, size = 12 }) {
  const r = Math.round(n)
  return <span className="rating" style={{ fontSize: size }}>{'★'.repeat(r)}{'☆'.repeat(5 - r)}</span>
}

export function Field({ label, req, hint, error, children, className = '' }) {
  return (
    <div className={`field ${className}`}>
      {label && <label className="label">{label}{req && <span className="req"> *</span>}</label>}
      {children}
      {error ? <span className="error">⚠ {error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  )
}

/** Campo de contraseña con botón para mostrarla u ocultarla. Acepta las mismas props que un input. */
export function PasswordInput({ className = 'input', style, ...props }) {
  const [ver, setVer] = useState(false)
  return (
    <div className="pass-wrap" style={style}>
      <input {...props} className={className} type={ver ? 'text' : 'password'} />
      <button type="button" className="pass-toggle" onClick={() => setVer(!ver)} aria-label={ver ? 'Ocultar contraseña' : 'Mostrar contraseña'} title={ver ? 'Ocultar contraseña' : 'Mostrar contraseña'}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {ver ? (
            <>
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
              <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
              <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </>
          ) : (
            <>
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </>
          )}
        </svg>
      </button>
    </div>
  )
}

/** Código QR ilustrativo (patrón determinista) para la representación impresa. */
export function QrFake({ seed = 'E320000000124' }) {
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const cells = []
  for (let i = 0; i < 144; i++) {
    h = (h * 1103515245 + 12345) >>> 0
    const x = i % 12, y = Math.floor(i / 12)
    const finder = (x < 3 && y < 3) || (x > 8 && y < 3) || (x < 3 && y > 8)
    cells.push(finder || (h >> 16) % 2 === 0)
  }
  return <div className="qr">{cells.map((on, i) => <i key={i} style={{ background: on ? '#111' : '#fff' }} />)}</div>
}

/** Código QR real con la URL oficial de consulta del e-CF en la DGII. */
export function QrDgii({ url, size = 110 }) {
  const [src, setSrc] = useState(null)
  useEffect(() => {
    let vivo = true
    QRCode.toDataURL(url, { margin: 1, width: size * 2, errorCorrectionLevel: 'M' }).then((d) => vivo && setSrc(d))
    return () => { vivo = false }
  }, [url, size])
  return src ? <img src={src} width={size} height={size} alt="Código QR de consulta en la DGII" /> : <div style={{ width: size, height: size }} />
}
