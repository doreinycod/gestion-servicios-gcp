import { useCallback, useEffect, useState } from 'react'
import { get } from './api'

/** Carga `ruta` de la API. Devuelve { data, error, cargando, recargar }. Con ruta null no carga. */
export function useApi(ruta) {
  const [version, setVersion] = useState(0)
  const clave = ruta ? `${ruta}#${version}` : null
  const [resultado, setResultado] = useState({ clave: null, data: null, error: null })

  useEffect(() => {
    if (!clave) return
    let vivo = true
    get(ruta)
      .then((data) => vivo && setResultado({ clave, data, error: null }))
      .catch((error) => vivo && setResultado({ clave, data: null, error }))
    return () => { vivo = false }
  }, [clave, ruta])

  const recargar = useCallback(() => setVersion((v) => v + 1), [])
  // Mientras llega la respuesta nueva se conservan los datos anteriores (evita parpadeos al recargar)
  const cargando = !!clave && resultado.clave !== clave
  return { data: resultado.data, error: cargando ? null : resultado.error, cargando, recargar }
}
