import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import { useSession, INICIO_POR_ROL } from './components/session'

// Un archivo por módulo funcional (sección 16.2)
import { Catalogo, PerfilPrestador, RegistroPrestador, CatalogoAdmin, Planes, PlanesAdmin } from './modulos/mod-cat'
import { NuevaSolicitud, Seguimiento, MisSolicitudes, PanelPrestador, Asignaciones, Agenda, Calificaciones, PerfilPrestadorPropio, SolicitudesAdmin } from './modulos/mod-sol'
import { Pagar, PaypalRetorno, Recibo, PagosCliente, Cobros, Conciliacion, Ganancias, CuentasPrestadores } from './modulos/mod-pag'
import { MisFacturas, FacturaPDF, Facturacion } from './modulos/mod-fac'
import { Asistente, AsistenteAdmin } from './modulos/mod-ia'
import { Login, Registro, OlvideContrasena, RestablecerContrasena, MiPerfil, Dashboard, PrestadoresAdmin, Usuarios, Reportes, Configuracion } from './modulos/mod-adm'

function Inicio() {
  const { rol } = useSession()
  return <Navigate to={rol ? INICIO_POR_ROL[rol] : '/login'} replace />
}

export default function App() {
  return (
    <Routes>
      {/* Acceso (ADM-P01, CAT-P03) */}
      <Route path="/login" element={<Login />} />
      <Route path="/registro" element={<Registro />} />
      <Route path="/olvide" element={<OlvideContrasena />} />
      <Route path="/restablecer" element={<RestablecerContrasena />} />
      <Route path="/prestadores/registro" element={<RegistroPrestador />} />
      <Route path="/facturas/:numero" element={<FacturaPDF />} />

      {/* Cliente: MOD-CAT, MOD-SOL, MOD-PAG, MOD-FAC, MOD-IA */}
      <Route element={<Layout rol="Cliente" />}>
        <Route path="/catalogo" element={<Catalogo />} />
        <Route path="/prestadores/:slug" element={<PerfilPrestador />} />
        <Route path="/solicitudes/nueva" element={<NuevaSolicitud />} />
        <Route path="/seguimiento/:codigo" element={<Seguimiento />} />
        <Route path="/mis-solicitudes" element={<MisSolicitudes />} />
        <Route path="/pagos" element={<PagosCliente />} />
        <Route path="/pagos/recibo/:id" element={<Recibo />} />
        <Route path="/pagos/paypal/retorno" element={<PaypalRetorno />} />
        <Route path="/pagos/:codigo" element={<Pagar />} />
        <Route path="/mis-facturas" element={<MisFacturas />} />
        <Route path="/planes" element={<Planes />} />
        <Route path="/asistente" element={<Asistente />} />
        <Route path="/perfil" element={<MiPerfil />} />
      </Route>

      {/* Prestador (empleado): SOL-P04, PAG-P05 */}
      <Route element={<Layout rol="Empleado" />}>
        <Route path="/prestador" element={<PanelPrestador />} />
        <Route path="/prestador/asignaciones" element={<Asignaciones />} />
        <Route path="/prestador/agenda" element={<Agenda />} />
        <Route path="/prestador/cobros" element={<Cobros />} />
        <Route path="/prestador/ganancias" element={<Ganancias />} />
        <Route path="/prestador/membresia" element={<Planes para="Prestador" />} />
        <Route path="/prestador/facturas" element={<MisFacturas />} />
        <Route path="/prestador/recibo/:id" element={<Recibo />} />
        <Route path="/prestador/paypal/retorno" element={<PaypalRetorno />} />
        <Route path="/prestador/calificaciones" element={<Calificaciones />} />
        <Route path="/prestador/perfil" element={<PerfilPrestadorPropio />} />
      </Route>

      {/* Administrador: MOD-ADM y paneles de control */}
      <Route element={<Layout rol="Administrador" />}>
        <Route path="/admin" element={<Dashboard />} />
        <Route path="/admin/catalogo" element={<CatalogoAdmin />} />
        <Route path="/admin/prestadores" element={<PrestadoresAdmin />} />
        <Route path="/admin/solicitudes" element={<SolicitudesAdmin />} />
        <Route path="/admin/pagos" element={<Conciliacion />} />
        <Route path="/admin/cuentas-prestadores" element={<CuentasPrestadores />} />
        <Route path="/admin/facturacion" element={<Facturacion />} />
        <Route path="/admin/planes" element={<PlanesAdmin />} />
        <Route path="/admin/asistente" element={<AsistenteAdmin />} />
        <Route path="/admin/usuarios" element={<Usuarios />} />
        <Route path="/admin/reportes" element={<Reportes />} />
        <Route path="/admin/configuracion" element={<Configuracion />} />
      </Route>

      <Route path="*" element={<Inicio />} />
    </Routes>
  )
}
